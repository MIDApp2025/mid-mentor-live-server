const admin = require("firebase-admin");
const { Buffer } = require("buffer");

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(
    Buffer.from(
      process.env.GOOGLE_SERVICE_ACCOUNT_BASE64,
      "base64"
    ).toString("utf-8")
  );

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

async function verifyEmployeeAccess(userId) {
  const db = admin.firestore();

  const docRef = db.collection("userProfiles").doc(userId);
  const docSnap = await docRef.get();

  if (!docSnap.exists) {
    throw new Error("PROFILE_NOT_FOUND");
  }

  const userData = docSnap.data() || {};

  const companyId =
    userData.companyId && userData.companyId !== "null"
      ? String(userData.companyId).trim()
      : null;

  if (!companyId) {
    throw new Error("COMPANY_NOT_FOUND");
  }

  let accessAllowed = false;

  const subSnap = await db
    .collection("growthSubscriptions")
    .where("companyId", "==", companyId)
    .limit(1)
    .get();

  if (!subSnap.empty) {
    const subData = subSnap.docs[0].data();
    const now = new Date();

    const isActive = subData.subscriptionStatus === "active";
    const isTrialValid =
      subData.trialEndDate && new Date(subData.trialEndDate) > now;

    accessAllowed = isActive || isTrialValid;
  }

  if (!accessAllowed) {
    throw new Error("SUBSCRIPTION_REQUIRED");
  }

  const companyDoc = await db.collection("companies").doc(companyId).get();

  if (!companyDoc.exists) {
    throw new Error("COMPANY_NOT_FOUND");
  }

  const companyData = companyDoc.data() || {};

  const official = String(companyData.accessCode || "").trim();
  const userHas = String(userData.accessCode || "").trim();

  if (official !== userHas) {
    throw new Error("ACCESS_CODE_INVALID");
  }

  return {
    userId,
    companyId,
    userData,
    companyData,
  };
}

module.exports = {
  verifyEmployeeAccess,
};
