require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { randomUUID } = require('crypto');

/* ------------------------------------------
   ENV
-------------------------------------------*/
const {
  PRIVATE_KEY,
  CAPTCHA_KEY,
  TURNSTILE_SITEKEY,
  RPC,
  API_BASE,
  CLIENT_ID,
  RECIPIENT,
  RELAYER,
  TOKEN,
  MINT_COUNT = 10,
  GAS_PRICE_GWEI,
  GAS_LIMIT
} = process.env;

/* ------------------------------------------
   PROVIDER + WALLET
-------------------------------------------*/
const provider = new ethers.providers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const WALLET = wallet.address;

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------
   GAS OPTIONS HELPER
-------------------------------------------*/
function gasOptions() {
  const opts = {};
  if (GAS_PRICE_GWEI) {
    opts.gasPrice = ethers.utils.parseUnits(GAS_PRICE_GWEI, "gwei");
  }
  if (GAS_LIMIT) {
    opts.gasLimit = Number(GAS_LIMIT);
  }
  return opts;
}

/* ------------------------------------------
   CAPTCHA SOLVER
-------------------------------------------*/
async function solveTurnstile() {
  const job = await axios.get(
    `http://2captcha.com/in.php?key=${CAPTCHA_KEY}&method=turnstile&sitekey=${TURNSTILE_SITEKEY}&pageurl=https://www.b402.ai/experience-b402&json=1`
  );

  const id = job.data.request;

  while (true) {
    await delay(5000);
    const r = await axios.get(
      `http://2captcha.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${id}&json=1`
    );
    if (r.data.status === 1) return r.data.request;
    process.stdout.write(".");
  }
}

/* ------------------------------------------
   AUTH
-------------------------------------------*/
async function getChallenge(ts) {
  const lid = randomUUID();
  const res = await axios.post(`${API_BASE}/auth/web3/challenge`, {
    walletType: "evm",
    walletAddress: WALLET,
    clientId: CLIENT_ID,
    lid,
    turnstileToken: ts
  });
  return { lid, challenge: res.data };
}

async function verifyChallenge(lid, sig, ts) {
  const res = await axios.post(`${API_BASE}/auth/web3/verify`, {
    walletType: "evm",
    walletAddress: WALLET,
    clientId: CLIENT_ID,
    lid,
    signature: sig,
    turnstileToken: ts
  });
  return res.data;
}

/* ------------------------------------------
   APPROVE USDT UNLIMITED
-------------------------------------------*/
async function approveUnlimited() {
  const abi = ["function approve(address spender, uint256 value)"];
  const token = new ethers.Contract(TOKEN, abi, wallet);

  const Max = ethers.constants.MaxUint256;
  console.log("🟦 Approving unlimited USDT for relayer...");

  const tx = await token.approve(RELAYER, Max, gasOptions());
  console.log("🔄 Approve TX:", tx.hash);
  await tx.wait();

  console.log("🟩 Unlimited USDT approved!");
}

/* ------------------------------------------
   PERMIT BUILDER
-------------------------------------------*/
async function buildPermit(amount, relayer) {
  const net = await provider.getNetwork();
  const now = Math.floor(Date.now() / 1000);

  const msg = {
    token: TOKEN,
    from: WALLET,
    to: RECIPIENT,
    value: amount,
    validAfter: now - 20,
    validBefore: now + 1800,
    nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32))
  };

  const domain = {
    name: "B402",
    version: "1",
    chainId: net.chainId,
    verifyingContract: relayer
  };

  const types = {
    TransferWithAuthorization: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }
    ]
  };

  const sig = await wallet._signTypedData(domain, types, msg);
  return { authorization: msg, signature: sig };
}

/* ------------------------------------------
   MAIN CLAIM FLOW
-------------------------------------------*/
async function runClaim(jwt) {
  console.log("🔍 Fetching payment requirement...");

  let pay;
  try {
    await axios.post(
      `${API_BASE}/faucet/drip`,
      { recipientAddress: RECIPIENT },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
  } catch (err) {
    if (err.response?.status === 402) {
      pay = err.response.data.paymentRequirements;
      console.log("💰 Payment requirement:", pay.amount);
    } else {
      throw new Error("❌ Cannot fetch payment requirement");
    }
  }

  console.log("🟦 Approving unlimited...");
  await approveUnlimited();

  console.log(`🧱 Building ${MINT_COUNT} permits...`);
  const permits = [];
  for (let i = 0; i < MINT_COUNT; i++) {
    permits.push(await buildPermit(pay.amount, pay.relayerContract));
  }

  console.log("\n🚀 START MINTING (will finish ALL permits)…\n");

  const concurrencyLimit = 3;
  let running = 0;
  let index = 0;
  const results = new Array(permits.length).fill("pending");

  function mintPermit(p, i) {
    return axios.post(
      `${API_BASE}/faucet/drip`,
      {
        recipientAddress: RECIPIENT,
        paymentPayload: { token: TOKEN, payload: p },
        paymentRequirements: {
          network: pay.network,
          relayerContract: pay.relayerContract
        }
      },
      { headers: { Authorization: `Bearer ${jwt}` } }
    )
      .then(res => {
        console.log(`🟩 Mint #${i + 1} SUCCESS → ${res.data.nftTransaction}`);
        results[i] = "success";
      })
      .catch(err => {
        const msg = err.response?.data?.error || err.response?.data || err.message;
        const lower = JSON.stringify(msg).toLowerCase();

        if (lower.includes("already")) {
          console.log(`🟡 Mint #${i + 1} ALREADY CLAIMED`);
          results[i] = "success";
        } else {
          console.log(`🟥 Mint #${i + 1} FAILED →`, msg);
          results[i] = "failed";
        }
      });
  }

  async function pipeline() {
    while (index < permits.length) {
      if (running < concurrencyLimit) {
        const current = index++;
        running++;
        mintPermit(permits[current], current).finally(() => running--);
      } else {
        await delay(50);
      }
    }

    while (running > 0) await delay(50);
    return results;
  }

  const finalResults = await pipeline();

  console.log("\n📊 SUMMARY:", finalResults);

  const hasSuccess = finalResults.some(r => r === "success");

  if (hasSuccess) {
    console.log("\n🎉 At least 1 NFT minted successfully!");
    console.log("🛑 All permits processed → stopping script...");
    process.exit(0);
  } else {
    console.log("\n⚠ All mints failed, script will continue waiting for next distribution.");
  }
}

/* ------------------------------------------
   WATCHER
-------------------------------------------*/
const WATCH_ADDR = [
  "0x39dcdd14a0c40e19cd8c892fd00e9e7963cd49d3".toLowerCase(),
  "0xafcD15f17D042eE3dB94CdF6530A97bf32A74E02".toLowerCase()
];

let lastBlock = 0;
let runningClaim = false;

async function watchDistribution(jwt) {
  console.log("👁 Watching for distribution...");

  while (true) {
    try {
      const block = await provider.getBlockNumber();

      if (block > lastBlock) {
        const data = await provider.getBlockWithTransactions(block);

        for (let tx of data.transactions) {
          if (!runningClaim && WATCH_ADDR.includes(tx.from.toLowerCase())) {
            console.log("🔥 DISTRIBUTION DETECTED");

            runningClaim = true;
            await runClaim(jwt);
            runningClaim = false;

            console.log("👁 Watching again...");
          }
        }

        lastBlock = block;
      }
    } catch (err) {
      console.log("⚠ Watcher error:", err.message);
    }

    await delay(500);
  }
}

/* ------------------------------------------
   MAIN BOOT
-------------------------------------------*/
(async () => {
  console.log("🔵 Solving captcha...");
  const ts = await solveTurnstile();

  console.log("🔵 Getting challenge...");
  const { lid, challenge } = await getChallenge(ts);

  const signed = await wallet.signMessage(challenge.message);
  const verify = await verifyChallenge(lid, signed, ts);

  const jwt = verify.jwt || verify.token;

  console.log("🟢 LOGIN SUCCESS!");
  watchDistribution(jwt);
})();
