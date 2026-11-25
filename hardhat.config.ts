import "@nomicfoundation/hardhat-toolbox";
import "dotenv/config";
import type { HardhatUserConfig } from "hardhat/config";

const key = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.29",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    lasna: { url: process.env.LASNA_RPC ?? "https://lasna-rpc.rnk.dev/", chainId: 5318007, accounts: key },
    baseSepolia: { url: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org", chainId: 84532, accounts: key },
    unichainSepolia: { url: process.env.UNICHAIN_SEPOLIA_RPC ?? "https://sepolia.unichain.org", chainId: 1301, accounts: key },
  },
};

export default config;
