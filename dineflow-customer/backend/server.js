const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const {
  initializeApp,
  cert
} = require("firebase-admin/app");

const {
  getAuth
} = require("firebase-admin/auth");

const {
  getFirestore
} = require("firebase-admin/firestore");

dotenv.config();
console.log("Razorpay Key ID loaded:", Boolean(process.env.RAZORPAY_KEY_ID));
const app = express();

app.use(cors());
app.use(express.json());

// Firebase Admin Setup
const serviceAccount = require("./serviceAccountKey.json");

initializeApp({
  credential: cert(serviceAccount),
  projectId: process.env.FIREBASE_PROJECT_ID
});

const db = getFirestore();

// Razorpay Setup
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// Firebase Authentication
async function verifyFirebaseToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Authentication required"
      });
    }

    const token = authHeader.split(" ")[1];

    req.user = await getAuth().verifyIdToken(token);

    next();

  } catch (error) {
    console.error("Authentication Error:", error);

    return res.status(401).json({
      success: false,
      message: "Invalid Firebase authentication"
    });
  }
}

// Server Health Check
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "DineFlow Razorpay Backend Running"
  });
});

// CREATE RAZORPAY ORDER
app.post("/create-order", verifyFirebaseToken, async (req, res) => {
  try {
    const {
      table,
      guest,
      items,
      note
    } = req.body;

    if (
      !table ||
      !guest ||
      !guest.name ||
      !guest.phone ||
      !Array.isArray(items) ||
      items.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid order details"
      });
    }

    if (
      guest.name.trim().length < 2 ||
      !/^[6-9]\d{9}$/.test(guest.phone)
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid customer details"
      });
    }

    // Calculate price from Firestore
    let subtotal = 0;
    const orderItems = [];

    for (const item of items) {
      const id = String(item.id || "");
      const qty = Number(item.qty);

      if (
        !id ||
        !Number.isInteger(qty) ||
        qty < 1 ||
        qty > 50
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid menu item or quantity"
        });
      }

      const menuDoc = await db
        .collection("menuItems")
        .doc(id)
        .get();

      if (!menuDoc.exists) {
        return res.status(400).json({
          success: false,
          message: "Menu item not found: " + id
        });
      }

      const dish = menuDoc.data();

      if (
        dish.available === false ||
        dish.restaurantId !== "dineflow-demo"
      ) {
        return res.status(400).json({
          success: false,
          message: "Menu item unavailable: " + dish.name
        });
      }

      const price = Number(dish.price);

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "Invalid menu price"
        });
      }

      subtotal += price * qty;

      orderItems.push({
        id,
        name: dish.name,
        price,
        qty,
        category: dish.category || ""
      });
    }

    // Same GST calculation as customer website
    const tax = Math.round(subtotal * 0.05);
    const total = subtotal + tax;

    // Convert rupees into paise
    const amountPaise = Math.round(total * 100);

    if (
      !Number.isSafeInteger(amountPaise) ||
      amountPaise < 100 ||
      amountPaise > 100000000
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount"
      });
    }

    // Create Razorpay Order
    const razorpayOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: "INR",
      receipt: "DF_" + Date.now()
    });

    // Save pending payment details
    const pendingRef = db.collection("pendingPayments").doc();

    await pendingRef.set({
      uid: req.user.uid,
      table: String(table),
      guest: {
        name: guest.name.trim(),
        phone: guest.phone
      },
      items: orderItems,
      subtotal,
      tax,
      total,
      amountPaise,
      note: String(note || "").slice(0, 300),
      razorpayOrderId: razorpayOrder.id,
      paymentStatus: "Pending",
      restaurantId: "dineflow-demo",
      createdAt: new Date().toISOString()
    });
console.log("Razorpay Key ID:", process.env.RAZORPAY_KEY_ID);
    res.json({
      success: true,
      keyId: process.env.RAZORPAY_KEY_ID,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      razorpayOrderId: razorpayOrder.id,
      pendingId: pendingRef.id
    });

  } catch (error) {
    console.error("Create Order Error:", error);

    res.status(500).json({
      success: false,
      message: "Unable to create payment order"
    });
  }
});

// VERIFY RAZORPAY PAYMENT
app.post("/verify-payment", verifyFirebaseToken, async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      pendingId
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature ||
      !pendingId
    ) {
      return res.status(400).json({
        success: false,
        message: "Payment details missing"
      });
    }

    const pendingRef = db
      .collection("pendingPayments")
      .doc(pendingId);

    const pendingSnap = await pendingRef.get();

    if (!pendingSnap.exists) {
      return res.status(404).json({
        success: false,
        message: "Pending order not found"
      });
    }

    const pending = pendingSnap.data();

    if (
      pending.uid !== req.user.uid ||
      pending.razorpayOrderId !== razorpay_order_id
    ) {
      return res.status(403).json({
        success: false,
        message: "Order authentication failed"
      });
    }

    // Prevent duplicate order creation
    if (pending.paymentStatus === "Paid" && pending.orderId) {
      return res.json({
        success: true,
        orderId: pending.orderId,
        message: "Payment already verified"
      });
    }

    // Verify signature
    const body =
      razorpay_order_id + "|" + razorpay_payment_id;

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    const signatureBuffer = Buffer.from(
      expectedSignature,
      "hex"
    );

    const receivedBuffer = Buffer.from(
      razorpay_signature,
      "hex"
    );

    if (
      signatureBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(
        signatureBuffer,
        receivedBuffer
      )
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment verification failed"
      });
    }

    // Verify actual Razorpay payment
    const payment = await razorpay.payments.fetch(
      razorpay_payment_id
    );

    if (
      payment.order_id !== razorpay_order_id ||
      payment.status !== "captured" ||
      payment.amount !== pending.amountPaise
    ) {
      return res.status(400).json({
        success: false,
        verified: false,
        message: "Payment is not captured or amount mismatch"
      });
    }

    // Create final restaurant order
    const orderRef = db.collection("orders").doc();

    const orderId = orderRef.id;

    const finalOrder = {
      id: orderId,
      table: pending.table,
      guest: {
        ...pending.guest,
        uid: pending.uid
      },
      customerUid: pending.uid,
      items: pending.items,
      subtotal: pending.subtotal,
      tax: pending.tax,
      total: pending.total,
      note: pending.note,
      payment: "Online (Razorpay)",
      paymentStatus: "Paid",
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id,
      status: 0,
      statusLabel: "Pending",
      restaurantId: "dineflow-demo",
      createdAt: new Date().toISOString()
    };

    // Save order and mark payment completed atomically
    const batch = db.batch();

    batch.set(orderRef, finalOrder);

    batch.update(pendingRef, {
      paymentStatus: "Paid",
      orderId,
      razorpayPaymentId: razorpay_payment_id,
      verifiedAt: new Date().toISOString()
    });

    await batch.commit();

    res.json({
      success: true,
      verified: true,
      orderId,
      paymentId: razorpay_payment_id,
      message: "Payment verified successfully"
    });

  } catch (error) {
    console.error("Payment Verification Error:", error);

    res.status(500).json({
      success: false,
      message: "Payment verification error"
    });
  }
});

// Start Server
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `DineFlow Backend running on port ${PORT}`
  );
});