# worker-qualification — CapyUber: Autopilot

Classroom simulation for RSU Digital Economy, Lecture 7 (unemployability).
Workers retrain for an autonomous-fleet job whose requirements rise each quarter.

## Files
- `params.js` — all tunable numbers (calibrated defaults)
- `engine.js` — simulation core (profiles, courses, policies, bots, hiring); Node + browser
- `calibrate.js`, `verify.js` — Monte Carlo calibration harness

## Calibration (1000 games)
No policy 25% hired · good-mix ceiling 56% · money-only 33%.
Age gradient: young/single 69%, 50+ & family 10%.

Design spec: see the project doc in Claude.
