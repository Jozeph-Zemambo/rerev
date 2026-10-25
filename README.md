# ReReV

An AR running buddy. A cartoon partner runs a couple of metres ahead of you on a glowing path laid over the real ground, paces itself to you and your live heart rate, talks to you, steers around obstacles it sees through the phone's depth camera, and climbs stairs with you.

> _Project story, inspiration and what we learned: to be written by Jozeph._

> **Heads up: the laptop version is not the real thing.** ReReV is built for Android phones with AR (Chrome on an ARCore phone). On a laptop you only get a simulated preview: a fake runner, fake camera and fake sensors in a cartoon room. It shows how the app works, but it's a big downgrade from the actual experience of the buddy running ahead of you in your real hallway or street. If you can, try it on a phone: **https://rerev.jkunistuff.workers.dev**

## Three ways to run

- **Plan a run:** pick a loop or a spot on the map, and the buddy leads you along a real OpenStreetMap route.
- **Quick start:** just go. The buddy follows wherever you walk or run.
- **Walk your course:** walk a route once (a loop, or out and back), then the buddy runs it with you, or prop the phone up and race it.

## Try it on a laptop

```bash
npm install
npm run dev
```

Open http://localhost:5173. Without AR, the app runs a preview with a simulated runner, depth camera, GPS and compass. Add `?course=obstacles` for a fixed obstacle course in Quick start, or `?course=line` for an out-and-back in Walk your course.

## Run it on an Android phone

WebXR AR needs Chrome on an ARCore phone, over https. The latest build is live at **https://rerev.jkunistuff.workers.dev**, and `npm run deploy` publishes a new one to Cloudflare. To try code changes without deploying, keep `npm run dev` running and tunnel it:

```bash
cloudflared tunnel --no-autoupdate --url http://localhost:5173
```

Then open the printed `https://…trycloudflare.com` link on the phone. Add `?debug` to the link, or long-press the Buddy tile during a run, for a live sensor readout.

## Heart rate from a Galaxy Watch

- **Over Bluetooth (anywhere):** install a Wear OS app that broadcasts heart rate like a chest strap (Heart for Bluetooth or HR2VP), then tap "Connect your watch" on the home screen.
- **Through the laptop (at a desk):** install HeartRateOnStream on the watch, run `npm run bridge` on the laptop, and set the watch app's OBS address to the IP it prints, port `4455`. No watch? `npm run bridge -- --simulate` fakes one.

## Convex setup

`npx convex dev` creates the backend and writes `.env.local` (`VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`). Then set these on the deployment:

- `HR_BRIDGE_TOKEN`: any secret, also added to `.env.local`, so the laptop bridge can post heart rate (`npx convex env set HR_BRIDGE_TOKEN …`).
- `ANTHROPIC_API_KEY` (optional): lets the buddy understand softer things you say, like "I'm tired". Without it, clear commands still work.

## Tests

```bash
npm test
```
