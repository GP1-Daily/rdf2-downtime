# RDF3 Grab Crane readiness

GP1 Connect can receive each saved RDF2 lift directly from the small Grab
Crane ESP32. The device sends integer kilograms; GP1 stores kilograms and
converts them to tons only for display.

## Render configuration

Set these environment variables before connecting the device:

```env
RDF3_GRAB_DEVICE_ID=grabcrane-01
RDF3_GRAB_SYNC_TOKEN=<different random secret with at least 32 characters>
```

Do not reuse `GRAB_SYNC_TOKEN` from the MSW Grab Crane.

## ESP32 configuration after calibration

Update `include/secrets.h` in the `grab_craneE` firmware:

```cpp
#define API_URL   "https://rdf2-downtime.onrender.com/api/device/rdf3-grab-sync"
#define API_KEY   "<same value as RDF3_GRAB_SYNC_TOKEN>"
#define DEVICE_ID "grabcrane-01"
```

The endpoint accepts the firmware's existing URL-encoded form fields:
`device`, `key`, `weight`, and `ts`. No local PHP or MySQL server is required.

Verify HTTPS support on the installed ESP32 build before field use. A saved
lift must return HTTP 200; temporary network or server failures stay in the
firmware's offline queue. Do not change the production URL until calibration,
an online save, and an offline-queue replay have all passed.

## Acceptance check

1. Calibrate and verify against at least one independent known weight.
2. Save one lift while online and confirm it appears on Home under
   `RDF3 Grab Crane` in tons.
3. Save one lift with Wi-Fi disconnected, reconnect Wi-Fi, and confirm it is
   uploaded once with the original weighing time.
4. Press Save only for real RDF2 transferred into RDF3. Zero, negative, wrong
   device, invalid token, and values over 1,000 kg are rejected.
5. Confirm daily Grab count, average tons per Grab, total tons, first time, and
   latest time before operational handover.

Until the Load Cell is installed and calibrated, do not send production rows.
With no RDF3 Grab rows, the existing RDF2 stock and reports are unchanged.
After go-live, every accepted row immediately subtracts normal-grade RDF2
stock and adds RDF3 output at the configured 82.35% conversion yield.
