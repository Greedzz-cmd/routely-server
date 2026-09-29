const express = require("express");

const asyncHandler = require("../middleware/asyncHandler");
const { requireAuth, optionalAuth, requireRole } = require("../middleware/auth");
const controller = require("../controllers/ticket.controller");

const router = express.Router();

// --- Public ---------------------------------------------------------------
router.get("/tickets", controller.getTickets);
router.get("/tickets/advertised", controller.getAdvertisedTickets);
router.get("/tickets/locations", controller.getLocations);
router.get("/tickets/transport-types", controller.getTransportTypes);
router.get("/tickets/routes/popular", controller.getPopularRoutes);

// --- Authenticated --------------------------------------------------------
router.get("/tickets/me", requireAuth, requireRole("vendor", "admin"), controller.getMyTickets);
router.get(
    "/tickets/manage",
    requireAuth,
    requireRole("admin"),
    controller.getTicketsForAdmin
);

router.post("/tickets", requireAuth, requireRole("vendor"), controller.createTicket);
router.patch("/tickets/:id", requireAuth, requireRole("vendor", "admin"), controller.updateTicket);
router.delete("/tickets/:id", requireAuth, requireRole("vendor", "admin"), controller.deleteTicket);

router.patch(
    "/tickets/:id/verification",
    requireAuth,
    requireRole("admin"),
    controller.moderateTicket
);

router.patch(
    "/tickets/:id/advertisement",
    requireAuth,
    requireRole("admin"),
    controller.toggleAdvertisement
);

router.get("/tickets/:id", optionalAuth, controller.getTicketById);

module.exports = router;
