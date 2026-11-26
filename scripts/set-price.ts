// Moves the demo price feed. Use it to put the price back to $3,000 after a demo or a test, since anyone can move it.
// The feed accepts at most a 50% move per update, so a big change is made in steps.
// Usage: npx ts-node scripts/set-price.ts [usd=3000]
import { link } from "./lib";
import { PX, c, setPrice } from "./loop";

async function main() {
  const target = Number(process.argv[2] ?? 3000);
  if (!(target >= 100 && target <= 20000)) throw new Error("price must be between 100 and 20000");
  const before = Number(await c.feed.latestAnswer()) / 1e8;
  const tx = await setPrice(PX(target));
  console.log(tx ? `price ${before} -> ${target}: ${link("base", "tx", tx.hash)}` : `price is already ${target}`);
}
main().catch((e) => { console.error(e.shortMessage ?? e.message ?? e); process.exit(1); });
