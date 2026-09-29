const express = require("express");

const { requireAuth } = require("../middleware/auth");
const asyncHandler = require("../middleware/asyncHandler");
const ticketRoutes = require("./ticket.routes");
const bookingRoutes = require("./booking.routes");

const router = express.Router();

/** Echoes the verified token payload, used by the client to confirm a session. */
router.get(
    "/me",
    requireAuth,
    asyncHandler(async (req, res) => {
        res.json({ user: req.user });
    })
);

router.use(ticketRoutes);
router.use(bookingRoutes);

module.exports = router;
