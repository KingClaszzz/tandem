import { useCallback, useEffect, useState } from "react";
import { createWalletClient, custom, numberToHex, type Abi, type Address, type Hash } from "viem";
import { CHAIN, client, type Lane } from "./chain";

type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<any>; on?(e: string, f: (...a: any[]) => void): void; removeListener?(e: string, f: (...a: any[]) => void): void };
const eth = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

export function useWallet() {
  const [account, setAccount] = useState<Address>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const p = eth();
    if (!p) return;
    p.request({ method: "eth_accounts" }).then((a: Address[]) => setAccount(a[0])).catch(() => {});
    const onAcc = (a: Address[]) => setAccount(a[0]);
    p.on?.("accountsChanged", onAcc);
    return () => p.removeListener?.("accountsChanged", onAcc);
  }, []);

  const connect = useCallback(async () => {
    setError(undefined);
    const p = eth();
    if (!p) return setError("No browser wallet found. Install MetaMask or Rabby.");
    try {
      const a: Address[] = await p.request({ method: "eth_requestAccounts" });
      setAccount(a[0]);
    } catch (e) {
      setError(short(e));
    }
  }, []);

  return { account, connect, error, hasWallet: Boolean(eth()) };
}

async function switchTo(lane: Lane) {
  const p = eth()!;
  const c = CHAIN[lane];
  const current = parseInt(await p.request({ method: "eth_chainId" }), 16);
  if (current === c.id) return;
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
}

/** Switches the wallet to `lane`, sends the call, and waits for the receipt on that chain. */
export async function send(lane: Lane, account: Address, address: Address, abi: Abi, functionName: string, args: unknown[] = []) {
  await switchTo(lane);
  const w = createWalletClient({ account, chain: CHAIN[lane], transport: custom(eth()!) });
  const hash: Hash = await w.writeContract({ address, abi, functionName, args, chain: CHAIN[lane], account } as any);
  const receipt = await client[lane].waitForTransactionReceipt({ hash, pollingInterval: 300 });
  if (receipt.status !== "success") throw new Error("Transaction reverted");
  return { hash, receipt, minedAt: performance.now() };
}

export function short(e: unknown): string {
  const m = (e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  if (/user rejected|denied/i.test(m)) return "You rejected the request in your wallet.";
  return m.split("\n")[0].slice(0, 160);
}

export const fmtAddr = (a?: string) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
