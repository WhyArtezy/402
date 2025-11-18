require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { randomUUID } = require('crypto');

/* ------------------------------------------
   PROVIDER
-------------------------------------------*/
const RPC = process.env.RPC;
const provider = new ethers.providers.JsonRpcProvider(RPC);

const delay = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------
   ENV (non-sensitive)
-------------------------------------------*/
const {
  CAPTCHA_KEY,
  TURNSTILE_SITEKEY,
  API_BASE,
  CLIENT_ID,
  RECIPIENT,
  RELAYER,
  TOKEN,
  MINT_COUNT
} = process.env;

/* ------------------------------------------
   GAS SETTINGS FROM .env
-------------------------------------------*/
const GAS_PRICE_GWEI = parseFloat(process.env.GAS_PRICE_GWEI || "3");
const GAS_LIMIT = parseInt(process.env.GAS_LIMIT || "120000");

function getGasOptions() {
  return {
    gasPrice: ethers.utils.parseUnits(GAS_PRICE_GWEI.toString(), "gwei"),
    gasLimit: GAS_LIMIT
  };
}

console.log(`⚙ Gas Price: ${GAS_PRICE_GWEI} gwei`);
console.log(`⚙ Gas Limit: ${GAS_LIMIT}`);

/* ------------------------------------------
   INTERACTIVE INPUT (PRIVATE KEY + MINT COUNT)
-------------------------------------------*/
const readline = require("readline");

async function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve =>
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

let wallet = null;
let WALLET = null;
let GLOBAL_MINT_COUNT = 1;

async function interactiveInputs() {
  // PRIVATE KEY
  let pk = await ask("🔑 Masukkan PRIVATE KEY: ");
  if (!pk || pk.length < 30) {
    console.log("❌ Private key tidak valid");
    process.exit(1);
  }

  // MINT COUNT
  let mc = await ask("🔢 Masukkan mint count: ");
  mc = parseInt(mc);
  if (isNaN(mc) || mc <= 0) {
    console.log("❌ Mint count tidak valid, fallback .env MINT_COUNT");
    mc = parseInt(MINT_COUNT || "1");
  }

  return { pk, mc };
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
   AUTH SYSTEM
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
   APPROVE USDT UNLIMITED (with custom gas)
-------------------------------------------*/
async function approveUnlimited() {
  const abi = ["function approve(address spender, uint256 value)"];
  const token = new ethers.Contract(TOKEN, abi, wallet);

  const Max = ethers.constants.MaxUint256;

  console.log("🟦 Approving unlimited USDT for relayer...");
  console.log(`⚙ Using Gas → Price ${GAS_PRICE_GWEI} gwei | Limit ${GAS_LIMIT}`);

  const tx = await token.approve(
    RELAYER,
    Max,
    getGasOptions()
  );

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
   MINT EXECUTION FLOW
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

  console.log(`🧱 Building ${GLOBAL_MINT_COUNT} permits...`);
  const permits = [];
  for (let i = 0; i < GLOBAL_MINT_COUNT; i++) {
    permits.push(await buildPermit(pay.amount, pay.relayerContract));
    console.log(`✔ Permit ${i + 1}`);
  }

  console.log("\n🚀 Sending Permits (Concurrency=3)…\n");

  const concurrencyLimit = 3;
  let running = 0;
  let index = 0;

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
      })
      .catch(err => {
        const msg = err.response?.data?.error || err.response?.data || err.message;
        const lower = JSON.stringify(msg).toLowerCase();
        if (lower.includes("already")) {
          console.log(`🟡 Mint #${i + 1} SKIPPED (already minted)`);
        } else {
          console.log(`🟥 Mint #${i + 1} FAILED →`, msg);
        }
      });
  }

  async function pipeline() {
    while (index < permits.length) {
      if (running < concurrencyLimit) {
        const c = index++;
        running++;

        mintPermit(permits[c], c).finally(() => {
          running--;
        });
      } else {
        await delay(50);
      }
    }

    while (running > 0) {
      await delay(50);
    }
  }

  await pipeline();
  console.log("\n🎉 DONE — All permits processed!\n");
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
  console.log("👁 Watching distribution…");

  while (true) {
    try {
      const block = await provider.getBlockNumber();

      if (block > lastBlock) {
        const data = await provider.getBlockWithTransactions(block);

        for (let tx of data.transactions) {
          if (!runningClaim && WATCH_ADDR.includes(tx.from.toLowerCase())) {
            console.log("🔥 DISTRIBUTION DETECTED →", tx.from);

            runningClaim = true;
            await runClaim(jwt);
            runningClaim = false;

            console.log("👁 Restart watcher…");
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
   MAIN START
-------------------------------------------*/
(async () => {

  // Ask for PK + Mint Count
  const data = await interactiveInputs();
  GLOBAL_MINT_COUNT = data.mc;

  wallet = new ethers.Wallet(data.pk, provider);
  WALLET = wallet.address;

  console.log("➡ PRIVATE KEY Loaded");
  console.log("➡ Mint Count:", GLOBAL_MINT_COUNT);
  console.log("➡ Wallet:", WALLET);

  // Solve captcha
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
