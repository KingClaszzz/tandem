import { useCallback, useEffect, useRef, useState } from "react";
import { createWalletClient, custom, numberToHex, type Abi, type Address, type Hash } from "viem";
import { CHAIN, client, type Lane } from "./chain";

type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<any>; on?(e: string, f: (...a: any[]) => void): void; removeListener?(e: string, f: (...a: any[]) => void): void };
const eth = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

// Wallets have no standard "disconnect", so the app remembers that the user chose to disconnect and does not
// reconnect silently on the next visit. Connecting again clears it.
const FLAG = "tandem:disconnected";
const disconnected = () => { try { return localStorage.getItem(FLAG) === "1"; } catch { return false; } };
const setDisconnected = (v: boolean) => { try { v ? localStorage.setItem(FLAG, "1") : localStorage.removeItem(FLAG); } catch { /* storage unavailable */ } };

export function useWallet() {
  const [account, setAccount] = useState<Address>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  // False only while a returning visitor's wallet is being asked for its accounts, so the gate does not flash.
  const [ready, setReady] = useState(() => !eth() || disconnected());
  const connecting = useRef(false);

  useEffect(() => {
    const p = eth();
    if (!p) return;
    if (!disconnected()) {
      p.request({ method: "eth_accounts" }).then((a: Address[]) => setAccount(a[0])).catch(() => {}).finally(() => setReady(true));
    }
    const onAcc = (a: Address[]) => { if (!disconnected()) setAccount(a?.[0]); };
    const onGone = () => setAccount(undefined);
    p.on?.("accountsChanged", onAcc);
    p.on?.("disconnect", onGone);
    return () => { p.removeListener?.("accountsChanged", onAcc); p.removeListener?.("disconnect", onGone); };
  }, []);

  const connect = useCallback(async () => {
    if (connecting.current) return; // a second click while the wallet popup is open does nothing
    connecting.current = true;
    setError(undefined);
    try {
      const p = eth();
      if (!p) return setError("No browser wallet found. Install MetaMask or Rabby.");
      const a: Address[] = await p.request({ method: "eth_requestAccounts" });
      setDisconnected(false);
      setAccount(a[0]);
    } catch (e) {
      setError(short(e));
    } finally {
      connecting.current = false;
    }
  }, []);

  const disconnect = useCallback(async () => {
    setDisconnected(true);
    setAccount(undefined);
    setError(undefined);
    // MetaMask and Rabby can revoke the site's access; other wallets ignore this, and the flag above still holds.
    try { await eth()?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch { /* not supported */ }
  }, []);

  /** Opens the wallet's account picker, so the user can choose a different account for this site. */
  const switchAccount = useCallback(async () => {
    setError(undefined);
    setNotice(undefined);
    const p = eth();
    if (!p) return setError("No browser wallet found. Install MetaMask or Rabby.");
    try {
      const before = (await p.request({ method: "eth_accounts" }) as Address[])[0];
      try {
        await p.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      } catch (e: any) {
        // The user closed the picker: stop. A wallet without this method: fall through to a plain connect request.
        if (e?.code === 4001 || /reject|denied|cancel/i.test(String(e?.message))) throw e;
      }
      const a: Address[] = await p.request({ method: "eth_requestAccounts" });
      setDisconnected(false);
      setAccount(a[0]);
      if (before && a[0]?.toLowerCase() === before.toLowerCase()) {
        setNotice("Same account as before. Pick another one in your wallet's list, or switch accounts inside the wallet itself.");
      }
    } catch (e) {
      setError(short(e));
    }
  }, []);

  const dismissNotice = useCallback(() => setNotice(undefined), []);
  return { account, connect, disconnect, switchAccount, error, notice, dismissNotice, ready, hasWallet: Boolean(eth()) };
}

async function switchTo(lane: Lane) {
  const p = eth()!;
  const c = CHAIN[lane];
  const current = async () => parseInt(await p.request({ method: "eth_chainId" }), 16);
  if ((await current()) === c.id) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(c.id) }] });
  } catch (e: any) {
    if (e?.code !== 4902 && !/unrecognized|not added/i.test(String(e?.message))) throw e;
    await p.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: numberToHex(c.id), chainName: c.name, nativeCurrency: c.nativeCurrency,
        rpcUrls: c.rpcUrls.default.http, blockExplorerUrls: c.blockExplorers ? [c.blockExplorers.default.url] : [],
      }],
    });
  }
  // Never trust that a switch worked: a transaction signed for the wrong chain is the wallet's problem, not ours.
  if ((await current()) !== c.id) throw new Error(`Your wallet is still on another network. Switch to ${c.name} and try again.`);
}

/**
 * Switches the wallet to `lane`, dry-runs the call, sends it once, and waits for the receipt on that chain.
 * - The dry run shows a revert reason before the user is asked to sign anything.
 * - The wallet transport never retries: a retried eth_sendTransaction can open the confirmation popup again.
 */
export async function send(lane: Lane, account: Address, address: Address, abi: Abi, functionName: string, args: unknown[] = []) {
  await switchTo(lane);
  await client[lane].simulateContract({ account, address, abi, functionName, args } as never);
  const w = createWalletClient({ account, chain: CHAIN[lane], transport: custom(eth()!, { retryCount: 0 }) });
  const hash: Hash = await w.writeContract({ address, abi, functionName, args, chain: CHAIN[lane], account } as never);
  let receipt;
  try {
    receipt = await client[lane].waitForTransactionReceipt({ hash, pollingInterval: 300, timeout: 120_000 });
  } catch {
    throw new Error(`The transaction was sent but is not confirmed after 2 minutes. Check ${hash} on the explorer.`);
  }
  if (receipt.status !== "success") throw new Error("The transaction reverted on-chain.");
  return { hash, receipt, minedAt: performance.now() };
}

const FRIENDLY: Record<string, string> = {
  TooSoon: "Too soon: the cooldown has not passed yet.",
  NoChange: "That is the price already.",
  MoveTooLarge: "A price update can move the price by at most 50%.",
  OutOfBounds: "The price must stay between $100 and $20,000.",
  BorrowOutOfRange: "A loan must be between 50 and 5,000 tUSD.",
  TooManyLoans: "Loan limit reached: 3 per wallet and 50 in total.",
  NotActive: "That loan is not active any more.",
  ZeroAmount: "The amount must be above zero.",
  NothingToRetry: "Nothing to retry on that loan.",
};

/** One readable line for any error a wallet, viem or a contract can throw. Always plain text. */
export function short(e: unknown): string {
  let code: unknown, name: unknown, message = "";
  for (let x: any = e, depth = 0; x && depth < 7; x = x.cause, depth++) {
    code ??= x.code;
    name ??= x.data?.errorName;
    if (!message) message = x.shortMessage ?? x.message ?? "";
  }
  const m = message || String(e);
  if (code === 4001 || /user rejected|user denied|rejected the request/i.test(m)) return "You rejected the request in your wallet.";
  if (typeof name === "string") return FRIENDLY[name] ?? `The contract refused the call (${name}).`;
  if (/current chain of the wallet|does not match the target chain/i.test(m)) return "Your wallet is on another network. Switch to the right one and try again.";
  return m.split("\n")[0].slice(0, 160);
}

export const fmtAddr = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
