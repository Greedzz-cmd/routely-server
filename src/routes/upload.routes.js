const express = require("express");

const { requireAuth, requireRole } = require("../middleware/auth");
const { uploadImage, getUploadStatus } = require("../controllers/upload.controller");

const router = express.Router();

router.get("/uploads/status", requireAuth, getUploadStatus);

// Vendors and admins are the only accounts that publish ticket imagery.
router.post(
    "/uploads/image",
    requireAuth,
    requireRole("vendor", "admin"),
    uploadImage
);

module.exports = router;
