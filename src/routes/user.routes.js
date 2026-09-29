const express = require("express");

const asyncHandler = require("../middleware/asyncHandler");
const { requireAuth, requireRole } = require("../middleware/auth");
const controller = require("../controllers/user.controller");

const router = express.Router();

// --- Self service ---------------------------------------------------------
router.get("/users/me", requireAuth, controller.getCurrentUser);
router.get("/transactions", requireAuth, controller.getMyTransactions);

// --- Vendor dashboards ----------------------------------------------------
router.get(
    "/vendor-stats",
    requireAuth,
    requireRole("vendor", "admin"),
    controller.getVendorStats
);

// Kept for the dashboard's existing call shape.
router.get(
    "/vendor-stats/:email",
    requireAuth,
    requireRole("vendor", "admin"),
    controller.getVendorStats
);

// --- Admin ----------------------------------------------------------------
router.get("/users", requireAuth, requireRole("admin"), controller.getUsers);
router.patch("/users/:id/role", requireAuth, requireRole("admin"), controller.changeRole);
router.patch("/users/:id/fraud", requireAuth, requireRole("admin"), controller.setFraud);
router.get("/admin-stats", requireAuth, requireRole("admin"), controller.getAdminStats);

module.exports = router;
