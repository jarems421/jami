/**
 * Draw a pink heart into somebody's sky.
 *
 * A one-off gift, like add-spider-constellation.mjs: one finished constellation
 * and the stars of its figure, written through the Admin SDK. Finished so the
 * next earned star does not land in the middle of the drawing.
 *
 *   node --env-file-if-exists=.env.local scripts/add-heart-constellation.mjs <email> <name>
 *   node --env-file-if-exists=.env.local scripts/add-heart-constellation.mjs <email> <name> --apply
 *
 * Without --apply it only reports what it would do.
 */
import process from "node:process";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

const [email, name, ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply");

if (!email || !name) {
  process.stdout.write("usage: add-heart-constellation.mjs <email> <name> [--apply]\n");
  process.exit(1);
}

const CONSTELLATION_ID = "heart";
const MAX_STARS = 40;
const STAR_COUNT = 16;

/**
 * The classic heart curve: x = 16 sin^3 t, y = 13 cos t - 5 cos 2t - 2 cos 3t - cos 4t.
 * t = 0 is the dip between the lobes and t = pi the point at the bottom.
 */
function heartPoint(t) {
  return {
    x: 16 * Math.sin(t) ** 3,
    y: 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
  };
}

/**
 * Stars spaced evenly along the outline rather than evenly in t, which would
 * bunch them at the dip and leave the lobes bare. An even count starting at
 * the dip puts one star on the bottom point too, and the figure stays mirrored.
 */
function outline(count) {
  const samples = 4000;
  const points = [];
  let length = 0;
  let previous = heartPoint(0);
  for (let index = 0; index <= samples; index += 1) {
    const point = heartPoint((index / samples) * Math.PI * 2);
    length += Math.hypot(point.x - previous.x, point.y - previous.y);
    points.push({ ...point, at: length });
    previous = point;
  }
  return Array.from({ length: count }, (_, index) => {
    const target = (index / count) * length;
    return points.find((point) => point.at >= target) ?? points[0];
  });
}

/*
 * Brightest at the dip, the bottom point and the crown of each lobe, so the
 * shape reads from the stars alone; the rest are quieter so it stays a fine
 * line rather than a wall of light. `cards` sets size through the app's own
 * curve (ln(cards + 1) onto 18-52px).
 */
function emphasis(index) {
  if (index === 0 || index === STAR_COUNT / 2) return { cards: 220, glow: 1 };
  if (index === 2 || index === STAR_COUNT - 2) return { cards: 160, glow: 0.95 };
  return index % 2 ? { cards: 12, glow: 0.6 } : { cards: 45, glow: 0.78 };
}

function buildFigure() {
  // Heart units span x -16..16 and y -17..12; the sky is percentages, y down.
  const stars = outline(STAR_COUNT).map((point, index) => ({
    id: `heart-${index + 1}`,
    x: Math.round((50 + point.x * 1.55) * 10) / 10,
    y: Math.round((46 - point.y * 1.75) * 10) / 10,
    ...emphasis(index),
  }));
  const lines = stars.map((star, index) => [star.id, stars[(index + 1) % stars.length].id]);
  return { stars, lines };
}

function orderedLine([a, b]) {
  return a < b ? { a, b } : { a: b, b: a };
}

const { stars, lines } = buildFigure();

if (stars.length > MAX_STARS) {
  process.stdout.write(`The figure needs ${stars.length} stars; the cap is ${MAX_STARS}.\n`);
  process.exit(1);
}

const projectId =
  process.env.FIREBASE_ADMIN_PROJECT_ID?.trim() ||
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID?.trim();
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL?.trim();
const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY?.trim()?.replace(/\\n/g, "\n");

if (!projectId || !clientEmail || !privateKey) {
  process.stdout.write("Missing FIREBASE_ADMIN_* environment variables.\n");
  process.exit(1);
}

if (!getApps().length) {
  initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
}

const db = getFirestore();

let uid;
try {
  uid = (await getAuth().getUserByEmail(email)).uid;
} catch {
  process.stdout.write(`No account found for ${email}.\n`);
  process.exit(1);
}

process.stdout.write(`Account: ${uid}\n`);
process.stdout.write(`Figure: ${stars.length} pink stars, ${lines.length} lines, named ${name}.\n`);
for (const star of stars) process.stdout.write(`  ${star.id}  (${star.x}, ${star.y})  cards ${star.cards}\n`);

const userRef = db.collection("users").doc(uid);
const constellationRef = userRef.collection("constellations").doc(CONSTELLATION_ID);

if ((await constellationRef.get()).exists) {
  process.stdout.write("A heart constellation is already on this account; nothing to do.\n");
  process.exit(0);
}

if (!apply) {
  process.stdout.write("\nDry run. Pass --apply to write it.\n");
  process.exit(0);
}

const createdAt = Date.now();
const batch = db.batch();

batch.set(constellationRef, {
  name,
  status: "finished",
  maxStars: MAX_STARS,
  starCount: stars.length,
  lines: lines.map(orderedLine),
  createdAt,
  finishedAt: createdAt,
});

stars.forEach((star, index) => {
  batch.set(userRef.collection("stars").doc(star.id), {
    goalId: star.id,
    constellationId: CONSTELLATION_ID,
    size: Math.log(star.cards + 1),
    glow: star.glow,
    starSchemaVersion: 2,
    position: { x: star.x, y: star.y },
    rewardKind: "onboarding",
    rewardLabel: name,
    tint: "pink",
    createdAt: createdAt - index,
  });
});

await batch.commit();

process.stdout.write(`Written. ${stars.length} stars and ${lines.length} lines.\n`);
