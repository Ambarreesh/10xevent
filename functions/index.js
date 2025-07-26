const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Razorpay = require("razorpay");
const crypto = require("crypto");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

// Set these once with:
// firebase functions:config:set razorpay.key_id="rzp_test_wjy3UX05excbjW" razorpay.key_secret="vJmhwdTRKgmutQJApinreDsQ" event.id="api-maze-2025"
const { key_id, key_secret } = functions.config().razorpay;
const EVENT_ID = (functions.config().event && functions.config().event.id) || "api-maze-2025";

const rzp = new Razorpay({
  key_id,
  key_secret
});

/** Allocate next participant number atomically */
async function allocateParticipantNumber() {
  const countersRef = db.collection("events").doc(EVENT_ID).collection("meta").doc("counters");
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(countersRef);
    if (!snap.exists) {
      tx.set(countersRef, { lastParticipantNo: 1 });
      return 1;
    }
    const curr = snap.data().lastParticipantNo || 0;
    const next = curr + 1;
    tx.update(countersRef, { lastParticipantNo: next });
    return next;
  });
}

function generateToken(regno = "") {
  const short = regno.replace(/\s+/g, "").slice(-4).toUpperCase();
  return `API25-${short}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * POST /api/create-order
 * body: { amount: 100 }
 * returns: { key_id, order_id, amount }
 */
exports.createOrder = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    try {
      const amount = (req.body && req.body.amount) ? Number(req.body.amount) : 100;
      const order = await rzp.orders.create({
        amount: amount * 100,
        currency: "INR",
        receipt: "rcpt_" + Date.now()
      });

      res.json({
        key_id,
        order_id: order.id,
        amount: order.amount
      });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: e.message });
    }
  });
});

/**
 * POST /api/verify-payment
 * body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, formData }
 */
exports.verifyPayment = functions.https.onRequest((req, res) => {
  cors(req, res, async () => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        formData
      } = req.body;

      const data = `${razorpay_order_id}|${razorpay_payment_id}`;
      const expectedSignature = crypto
        .createHmac("sha256", key_secret)
        .update(data)
        .digest("hex");

      if (expectedSignature !== razorpay_signature) {
        return res.status(400).json({ ok: false, error: "Invalid signature" });
      }

      const participant_no = await allocateParticipantNumber();
      const token = generateToken(formData?.regno);

      await db
        .collection("events")
        .doc(EVENT_ID)
        .collection("registrations")
        .doc(razorpay_payment_id)
        .set(
          {
            payment_id: razorpay_payment_id,
            order_id: razorpay_order_id,
            signature: razorpay_signature,
            participant_no,
            token,
            status: "success",
            amount: 100,
            conv_fee: 2.5,
            paid_at: admin.firestore.FieldValue.serverTimestamp(),
            ...formData
          },
          { merge: true }
        );

      res.json({ ok: true, participant_no, token });
    } catch (e) {
      console.error(e);
      res.status(500).json({ ok: false, error: e.message });
    }
  });
});