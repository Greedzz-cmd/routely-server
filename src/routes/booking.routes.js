const express = require("express");

const asyncHandler = require("../middleware/asyncHandler");
const { requireAuth, requireRole } = require("../middleware/auth");
const controller = require("../controllers/booking.controller");
const paymentService = require("../services/payment.service");
const { markBookingPaid } = require("../models/booking.model");
const { recordTransaction } = require("../models/transaction.model");

const router = express.Router();

/**
 * Stripe webhook.
 *
 * Verifies against the raw body captured by the JSON parser's verify hook.
 * Handling is idempotent: a redelivered event finds the booking already paid
 * and does nothing, so Stripe's retries cannot double charge or double count.
 */
router.post(
    "/payments/webhook",
    asyncHandler(async (req, res) => {
        const event = paymentService.constructWebhookEvent(
            req.rawBody || Buffer.from(JSON.stringify(req.body || {})),
            req.headers["stripe-signature"]
        );

        if (event.type === "checkout.session.completed") {
            const session = event.data.object;
            const bookingId = session.metadata?.bookingId || session.client_reference_id;

            if (bookingId) {
                const { booking, alreadyPaid } = await markBookingPaid(bookingId, {
                    transactionId: session.payment_intent || session.id,
                });

                if (!alreadyPaid) {
                    await recordTransaction({
                        booking,
                        provider: "stripe",
                        transactionId: session.payment_intent || session.id,
                    });
                }

                console.log(`[webhook] booking ${booking.pnr} marked paid.`);
            }
        }

        if (event.type === "checkout.session.expired") {
            console.log("[webhook] checkout session expired, booking left un-paid.");
        }

        res.json({ received: true });
    })
);

router.get("/bookings", requireAuth, controller.getBookings);
router.post("/bookings", requireAuth, controller.createBookingRequest);
router.get("/bookings/:id", requireAuth, controller.getBookingById);

router.patch(
    "/bookings/:id",
    requireAuth,
    requireRole("vendor", "admin"),
    controller.respondToBookingRequest
);

router.post("/bookings/:id/cancel", requireAuth, controller.cancelBookingRequest);
router.post("/bookings/:id/checkout", requireAuth, controller.startCheckout);
router.post("/bookings/:id/confirm", requireAuth, controller.confirmMockPayment);
router.post("/payments/confirm", requireAuth, controller.confirmPayment);

module.exports = router;
