// The health app's pet: a little creature whose mood follows the week's targets
// (weekly.py works out the numbers; this file only draws). Hand-made SVG in a
// kawaii style: one round body that is mostly head, big low-set eyes with two
// highlights, small features close together, blush, soft colours, and gentle
// motion (a bob, blinks, a wing flap when it's thriving). Motion stops under
// prefers-reduced-motion (app.css). No style="" attributes: colours are SVG
// attributes and motion is CSS classes, so the page's CSP is untouched.

const NS = "http://www.w3.org/2000/svg";
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, String(v));
  for (const c of kids.flat()) if (c) el.append(c);
  return el;
}

const NAVY = "#1d2a4d";
const BLUSH = "#ff8fab";

export const SPECIES = {
  owl: { name: "Blue owl", pet: "Blue", body: "#62a3ff", dark: "#3f82e6", face: "#dcebff", belly: "#eef6ff", mark: "#b6d3fb", beak: "#ffb44d", feet: "#ffa23a" },
  cat: { name: "Ginger cat", pet: "Mochi", body: "#ffb974", dark: "#f29a4a", face: "#fff1e2", belly: "#fff4e8", mark: "#f6c99b", nose: "#ff8fab", feet: "#ffb974" },
  penguin: { name: "Penguin", pet: "Pebble", body: "#4c6386", dark: "#3a4f70", face: "#ffffff", belly: "#ffffff", mark: "#dfe7f2", beak: "#ffb44d", feet: "#ffa23a" },
  fox: { name: "Fox", pet: "Ember", body: "#ff9555", dark: "#e9783a", face: "#fff6ee", belly: "#fff6ee", mark: "#ffd9bf", nose: "#3b2b2b", feet: "#5a3a2e" },
  bunny: { name: "Bunny", pet: "Bun", body: "#fde9f0", dark: "#f4c3d4", face: "#fff8fb", belly: "#fff8fb", mark: "#f6d0dd", nose: "#ff8fab", feet: "#fde9f0", line: "#efb6c9" },
  frog: { name: "Frog", pet: "Lily", body: "#8fd68f", dark: "#6cbf70", face: "#d9f5d4", belly: "#e6f8e1", mark: "#bfe8b8", feet: "#78c97b" },
};

/** Mood 0-100 to a band: thriving, happy, peckish or low. */
export function moodBand(m) {
  return m >= 85 ? "thriving" : m >= 65 ? "happy" : m >= 40 ? "peckish" : "low";
}
export const MOOD_WORDS = { thriving: "Thriving", happy: "Happy", peckish: "Peckish", low: "Under the weather" };

// Where each species' eyes sit (frogs wear theirs on top).
const EYES = { frog: { y: 66, dx: 28, r: 13 } };
const eyeAt = (sp) => EYES[sp] || { y: 104, dx: 20, r: 15 };

function eyes(sp, band, c) {
  const { y, dx, r } = eyeAt(sp);
  const g = s("g", { class: "pet-eyes" });
  for (const side of [-1, 1]) {
    const x = 100 + side * dx;
    if (band === "thriving") { // closed, smiling eyes: ^ ^
      g.append(s("path", { d: `M${x - r + 2} ${y + 3} Q${x} ${y - r + 1} ${x + r - 2} ${y + 3}`, fill: "none", stroke: NAVY, "stroke-width": 5, "stroke-linecap": "round" }));
      continue;
    }
    const lowered = band === "low" ? 3 : 0;
    const eye = s("g", { class: "pet-eye" },
      s("circle", { cx: x, cy: y + lowered, r, fill: NAVY }),
      s("circle", { cx: x + r * 0.33, cy: y - r * 0.38 + lowered, r: r * 0.36, fill: "#fff" }),
      s("circle", { cx: x - r * 0.3, cy: y + r * 0.35 + lowered, r: r * 0.15, fill: "#fff" }));
    g.append(eye);
    if (band === "low" || band === "peckish") { // heavy lids
      // the lid is the cap of the eye above line ly, in the colour around the eye
      const cover = band === "low" ? 0.42 : 0.18;
      const R = r + 1, ly = y + lowered - R + R * 2 * cover, half = Math.sqrt(R * R - (ly - y - lowered) ** 2);
      const around = ["owl", "penguin", "frog"].includes(sp) ? c.face : c.body;
      g.append(s("path", { d: `M${x - half} ${ly} A${R} ${R} 0 ${ly > y + lowered ? 1 : 0} 1 ${x + half} ${ly} Z`, fill: around }),
        s("path", { d: `M${x - half} ${ly} Q${x} ${ly + 2} ${x + half} ${ly}`, fill: "none", stroke: NAVY, "stroke-width": 2.5, "stroke-linecap": "round", opacity: 0.75 }));
    }
    if (band === "low") { // worried brows
      // worried, not cross: the inner ends of the brows lift
      g.append(s("path", { d: `M${x - side * 10} ${y - r - 13} Q${x} ${y - r - 12} ${x + side * 10} ${y - r - 7}`, fill: "none", stroke: NAVY, "stroke-width": 3, "stroke-linecap": "round", opacity: 0.6 }));
    }
  }
  return g;
}

/** Closed, happy eyes (^ ^): shown while it's being patted. */
function joyEyes(sp) {
  const { y, dx, r } = eyeAt(sp);
  return s("g", { class: "pet-joy" }, [-1, 1].map((side) => {
    const x = 100 + side * dx;
    return s("path", { d: `M${x - r + 2} ${y + 3} Q${x} ${y - r + 1} ${x + r - 2} ${y + 3}`, fill: "none", stroke: NAVY, "stroke-width": 5, "stroke-linecap": "round" });
  }));
}

function blush(sp, band) {
  const { y, dx } = eyeAt(sp);
  const yy = sp === "frog" ? 104 : y + 20;
  const op = band === "thriving" ? 0.7 : band === "happy" ? 0.5 : 0.3;
  return s("g", null,
    s("ellipse", { cx: 100 - dx - 18, cy: yy, rx: 9, ry: 5, fill: BLUSH, opacity: op }),
    s("ellipse", { cx: 100 + dx + 18, cy: yy, rx: 9, ry: 5, fill: BLUSH, opacity: op }));
}

function beak(c, band) {
  const open = band === "thriving";
  return s("g", null,
    s("path", { d: "M93 117 Q100 112 107 117 Q101 129 100 129 Q99 129 93 117 Z", fill: c.beak }),
    open ? s("path", { d: "M96 122 Q100 126 104 122", fill: "none", stroke: "#e08a1e", "stroke-width": 1.5, "stroke-linecap": "round" }) : null);
}

/** A small mouth for the furry ones: a cat's "w", a smile, or a wobble when low. */
function mouth(y, band, wide = false) {
  if (band === "low") return s("path", { d: `M92 ${y + 6} Q100 ${y} 108 ${y + 6}`, fill: "none", stroke: NAVY, "stroke-width": 2.5, "stroke-linecap": "round" });
  if (band === "thriving") return s("path", { d: `M${wide ? 84 : 91} ${y} Q100 ${y + (wide ? 16 : 12)} ${wide ? 116 : 109} ${y} Z`, fill: "#ff6f8e", stroke: NAVY, "stroke-width": 2, "stroke-linejoin": "round" });
  if (wide) return s("path", { d: `M84 ${y} Q100 ${y + 12} 116 ${y}`, fill: "none", stroke: NAVY, "stroke-width": 2.5, "stroke-linecap": "round" });
  return s("path", { d: `M92 ${y} Q96 ${y + 5} 100 ${y} Q104 ${y + 5} 108 ${y}`, fill: "none", stroke: NAVY, "stroke-width": 2.5, "stroke-linecap": "round", "stroke-linejoin": "round" });
}

const BODY = "M100 40 C150 40 172 80 172 118 C172 160 140 184 100 184 C60 184 28 160 28 118 C28 80 50 40 100 40 Z";

// ------------------------------------------------------------------ species
const BEHIND = {
  cat: (c) => s("path", { d: "M160 160 Q192 150 184 116 Q180 100 170 108", fill: "none", stroke: c.dark, "stroke-width": 12, "stroke-linecap": "round" }),
  fox: (c) => s("g", null,
    s("path", { d: "M150 168 Q200 160 192 112 Q188 92 168 104 Q178 132 146 150 Z", fill: c.body }),
    s("path", { d: "M192 112 Q188 92 168 104 Q176 112 182 122 Z", fill: "#fff6ee" })),
  bunny: (c) => s("g", null,
    s("ellipse", { cx: 76, cy: 30, rx: 15, ry: 38, fill: c.body, stroke: c.line, "stroke-width": 3, transform: "rotate(-12 76 30)" }),
    s("ellipse", { cx: 76, cy: 32, rx: 7, ry: 28, fill: "#ffc4d6", transform: "rotate(-12 76 32)" }),
    s("ellipse", { cx: 124, cy: 30, rx: 15, ry: 38, fill: c.body, stroke: c.line, "stroke-width": 3, transform: "rotate(12 124 30)" }),
    s("ellipse", { cx: 124, cy: 32, rx: 7, ry: 28, fill: "#ffc4d6", transform: "rotate(12 124 32)" })),
  frog: (c) => s("g", null, s("circle", { cx: 72, cy: 64, r: 24, fill: c.body }), s("circle", { cx: 128, cy: 64, r: 24, fill: c.body })),
};

function ears(sp, c) {
  if (sp === "owl") {
    return s("g", { class: "pet-tufts" },
      s("path", { d: "M46 76 Q34 36 74 44 Q60 56 62 70 Z", fill: c.dark }),
      s("path", { d: "M154 76 Q166 36 126 44 Q140 56 138 70 Z", fill: c.dark }));
  }
  if (sp === "cat") {
    return s("g", null,
      s("path", { d: "M44 78 L52 34 L84 52 Z", fill: c.body, "stroke-linejoin": "round" }), s("path", { d: "M54 66 L58 44 L74 54 Z", fill: "#ffc4d6" }),
      s("path", { d: "M156 78 L148 34 L116 52 Z", fill: c.body }), s("path", { d: "M146 66 L142 44 L126 54 Z", fill: "#ffc4d6" }));
  }
  if (sp === "fox") {
    return s("g", null,
      s("path", { d: "M40 82 L46 24 L88 50 Z", fill: c.body }), s("path", { d: "M46 24 L52 44 L60 36 Z", fill: "#4a2f28" }), s("path", { d: "M52 68 L54 44 L76 54 Z", fill: "#fff6ee" }),
      s("path", { d: "M160 82 L154 24 L112 50 Z", fill: c.body }), s("path", { d: "M154 24 L148 44 L140 36 Z", fill: "#4a2f28" }), s("path", { d: "M148 68 L146 44 L124 54 Z", fill: "#fff6ee" }));
  }
  return null;
}

function wings(sp, c) {
  // A raised wing or paw beside the face, shown only while it waves (CSS: .trick-wave).
  const winged = sp === "owl" || sp === "penguin";
  const arm = winged
    ? s("g", { class: "pet-arm" }, s("ellipse", { cx: 166, cy: 88, rx: 10, ry: 24, fill: c.dark, transform: "rotate(28 166 88)" }))
    : s("g", { class: "pet-arm" },
      s("ellipse", { cx: 164, cy: 92, rx: 12, ry: 14, fill: c.body, stroke: c.dark, "stroke-width": 2.5 }),
      s("circle", { cx: 164, cy: 95, r: 4, fill: "#ffb3c6" }),
      s("circle", { cx: 158, cy: 87, r: 2.2, fill: "#ffb3c6" }), s("circle", { cx: 164, cy: 84, r: 2.2, fill: "#ffb3c6" }), s("circle", { cx: 170, cy: 87, r: 2.2, fill: "#ffb3c6" }));
  if (winged) {
    return s("g", null,
      // the group flaps (CSS); the ellipse keeps its tilt (an SVG transform CSS would override)
      s("g", { class: "pet-wing pet-wing-l" }, s("ellipse", { cx: 39, cy: 132, rx: 11, ry: 24, fill: c.dark, transform: "rotate(16 39 132)" })),
      s("g", { class: "pet-wing pet-wing-r" }, s("ellipse", { cx: 161, cy: 132, rx: 11, ry: 24, fill: c.dark, transform: "rotate(-16 161 132)" })),
      arm);
  }
  // little paws for the rest, tucked in at the sides of the belly
  return s("g", null,
    s("ellipse", { class: "pet-paw-l", cx: 60, cy: 152, rx: 11, ry: 9, fill: c.body, stroke: c.dark, "stroke-width": 2.5 }),
    s("ellipse", { class: "pet-paw-r", cx: 140, cy: 152, rx: 11, ry: 9, fill: c.body, stroke: c.dark, "stroke-width": 2.5 }),
    arm);
}

function face(sp, c, band) {
  if (sp === "owl") {
    return s("g", null, s("circle", { cx: 79, cy: 104, r: 29, fill: c.face }), s("circle", { cx: 121, cy: 104, r: 29, fill: c.face }));
  }
  if (sp === "penguin") {
    return s("path", { d: "M100 70 C74 56 46 74 50 104 C54 140 82 164 100 166 C118 164 146 140 150 104 C154 74 126 56 100 70 Z", fill: c.face });
  }
  if (sp === "fox") {
    return s("path", { d: "M40 112 Q70 104 100 132 Q130 104 160 112 Q150 150 100 152 Q50 150 40 112 Z", fill: c.face });
  }
  if (sp === "cat" || sp === "bunny") {
    return s("ellipse", { cx: 100, cy: 128, rx: 26, ry: 18, fill: c.face });
  }
  if (sp === "frog") return s("g", null, s("circle", { cx: 72, cy: 64, r: 17, fill: c.face }), s("circle", { cx: 128, cy: 64, r: 17, fill: c.face }));
  return null;
}

function features(sp, c, band) {
  if (sp === "owl" || sp === "penguin") return beak(c, band);
  if (sp === "frog") return mouth(112, band, true);
  const nose = sp === "fox" ? s("ellipse", { cx: 100, cy: 122, rx: 6, ry: 4.5, fill: c.nose })
    : s("path", { d: "M95 120 Q100 117 105 120 Q100 127 95 120 Z", fill: c.nose });
  const whiskers = sp === "cat" ? s("g", { stroke: "#d98a52", "stroke-width": 2, "stroke-linecap": "round", opacity: 0.7 },
    s("path", { d: "M70 124 L48 120" }), s("path", { d: "M70 130 L48 132" }), s("path", { d: "M130 124 L152 120" }), s("path", { d: "M130 130 L152 132" })) : null;
  const teeth = sp === "bunny" && band !== "low" ? s("rect", { x: 96, y: 133, width: 8, height: 6, rx: 1.5, fill: "#fff", stroke: c.line, "stroke-width": 1.5 }) : null;
  return s("g", null, whiskers, nose, mouth(sp === "bunny" ? 128 : 129, band), teeth);
}

function belly(c) {
  return s("g", null,
    s("ellipse", { cx: 100, cy: 156, rx: 36, ry: 22, fill: c.belly }),
    ...[[86, 150], [100, 158], [114, 150]].map(([x, y]) => s("path", { d: `M${x - 4} ${y} q4 4 8 0`, fill: "none", stroke: c.mark, "stroke-width": 2.5, "stroke-linecap": "round" })));
}

// ------------------------------------------------------------------ accessories, earned by level
export const ACCESSORIES = [
  { level: 2, name: "a leaf sprout" },
  { level: 3, name: "a cosy scarf" },
  { level: 4, name: "a gold star" },
  { level: 5, name: "a little crown" },
];

function accessories(sp, level) {
  const top = sp === "frog" ? 42 : sp === "bunny" ? 44 : 40;
  const g = s("g", null);
  if (level >= 3) {
    g.append(s("path", { d: "M44 140 Q100 162 156 140 L158 151 Q100 174 42 151 Z", fill: "#ff6b81" }),
      s("path", { d: "M130 154 L138 182 L150 178 L142 152 Z", fill: "#ff5470" }),
      s("path", { d: "M60 148 L64 158 M80 153 L83 163 M100 156 L100 166 M120 153 L117 163", stroke: "#ffd1d9", "stroke-width": 2.5, "stroke-linecap": "round" }));
  }
  if (level >= 4) {
    g.append(s("path", { d: "M100 159 L103.5 166 L111 166.6 L105.3 171.4 L107 178.8 L100 175 L93 178.8 L94.7 171.4 L89 166.6 L96.5 166 Z", fill: "#ffd23f", stroke: "#f0a500", "stroke-width": 1.2 }));
  }
  if (level >= 5) {
    g.append(s("path", { d: `M82 ${top + 2} L84 ${top - 18} L93 ${top - 8} L100 ${top - 22} L107 ${top - 8} L116 ${top - 18} L118 ${top + 2} Z`, fill: "#ffd23f", stroke: "#f0a500", "stroke-width": 2, "stroke-linejoin": "round" }),
      s("circle", { cx: 100, cy: top - 6, r: 3, fill: "#ff6b81" }));
  } else if (level >= 2) {
    g.append(s("path", { d: `M100 ${top + 2} Q100 ${top - 8} 102 ${top - 14}`, fill: "none", stroke: "#3f9a4a", "stroke-width": 3, "stroke-linecap": "round" }),
      s("path", { d: `M102 ${top - 14} Q116 ${top - 24} 122 ${top - 12} Q110 ${top - 6} 102 ${top - 14} Z`, fill: "#7fd36b" }),
      s("path", { d: `M100 ${top - 8} Q88 ${top - 16} 82 ${top - 8} Q92 ${top - 2} 100 ${top - 8} Z`, fill: "#9be283" }));
  }
  return g;
}

function sparkles() {
  const star = (x, y, r, cls) => s("path", { class: `pet-spark ${cls}`, d: `M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r} Z`, fill: "#ffd23f" });
  const heart = (x, y, cls) => s("path", { class: `pet-spark ${cls}`, d: `M${x} ${y + 6} C${x - 12} ${y - 2} ${x - 6} ${y - 12} ${x} ${y - 5} C${x + 6} ${y - 12} ${x + 12} ${y - 2} ${x} ${y + 6} Z`, fill: "#ff8fab" });
  return s("g", null, star(26, 52, 8, "a"), star(178, 70, 6, "b"), heart(170, 34, "c"), star(18, 150, 5, "b"));
}

function zzz() { // tired: a sleepy little cloud of z's
  return s("g", { class: "pet-zzz", fill: NAVY, opacity: 0.45, "font-family": "Barlow, sans-serif", "font-weight": 700 },
    s("text", { x: 160, y: 50, "font-size": 18 }, document.createTextNode("z")),
    s("text", { x: 172, y: 34, "font-size": 13 }, document.createTextNode("z")));
}

/** The pet as an SVG element. opts: { mood 0-100, level, size, still } */
export function drawPet(sp, opts = {}) {
  const c = SPECIES[sp] || SPECIES.owl;
  const band = moodBand(opts.mood ?? 75);
  const size = opts.size || 160;
  const svg = s("svg", { viewBox: "0 0 200 200", width: size, height: size, class: `pet pet-${band}${opts.still ? " still" : ""}${opts.thirsty ? " thirsty" : ""}`, role: "img", "aria-label": `${c.name}, ${MOOD_WORDS[band].toLowerCase()}${opts.thirsty ? ", thirsty" : ""}` });
  svg.dataset.sp = sp;
  svg.append(s("ellipse", { class: "pet-shadow", cx: 100, cy: 190, rx: 46, ry: 7, fill: "#000", opacity: 0.1 }));
  const body = s("g", { class: "pet-body" });
  if (BEHIND[sp]) body.append(BEHIND[sp](c));
  body.append(
    s("ellipse", { cx: 82, cy: 182, rx: 11, ry: 6, fill: c.feet }), s("ellipse", { cx: 118, cy: 182, rx: 11, ry: 6, fill: c.feet }),
    ears(sp, c),
    s("path", { d: BODY, fill: c.body, stroke: c.line || "none", "stroke-width": c.line ? 3 : 0 }),
    s("ellipse", { cx: 66, cy: 66, rx: 15, ry: 8, fill: "#fff", opacity: 0.28, transform: "rotate(-32 66 66)" }), // a soft shine
    sp === "penguin" ? null : belly(c),
    face(sp, c, band),
    wings(sp, c),
    eyes(sp, band, c),
    band === "thriving" ? null : joyEyes(sp),
    blush(sp, band),
    features(sp, c, band),
    accessories(sp, opts.level || 1));
  svg.append(body);
  if (band === "thriving") svg.append(sparkles());
  if (band === "low") svg.append(zzz());
  if (opts.thirsty) svg.append(sweat());
  return svg;
}

const DROP = "M0 -9 C4 -3 7 1 7 4.5 A7 7 0 0 1 -7 4.5 C-7 1 -4 -3 0 -9 Z";
function sweat() { // thirsty: a drop of sweat by its head
  return s("g", { class: "pet-sweat" }, s("path", { d: DROP, fill: "#7cc4ff", stroke: "#3d8fe0", "stroke-width": 1.2, transform: "translate(158 58) scale(1.1)" }),
    s("ellipse", { cx: 156, cy: 61, rx: 1.6, ry: 2.6, fill: "#fff", opacity: 0.8 }));
}

/** What the pet says, from its mood and the wish weekly.py worked out. */
export function speech(name, mood, tip) {
  const band = moodBand(mood);
  const open = {
    thriving: "Hoo-ray! We're smashing this week.",
    happy: "Feeling good today!",
    peckish: "I'm a bit peckish…",
    low: "I'm not feeling my best.",
  }[band];
  return tip && band !== "thriving" ? `${open} ${tip}` : open;
}

// ------------------------------------------------------------------ tricks
// Big, bouncy moves: a double jump, a wave, a headbang, a dance and a spin. A tap
// does one (plus a puff of hearts and a line); left alone, the pet does one now and
// then, more often the better its week is going. A pet in a low mood has its own bag
// of tricks: it sulks under a rain cloud, melts into a puddle, sighs, shivers or sheds
// a tear, and a thirsty one fans itself. All of it is CSS on classes added for the
// moment (app.css), and none of it runs under reduced motion.
export const SOUNDS = {
  owl: ["Hoo hoo!", "Hoot! That tickles.", "Hooo! Again!"],
  cat: ["Mrrp!", "Purrr…", "Mew! Hehe."],
  penguin: ["Squawk!", "Waddle waddle!", "Hehe, my belly!"],
  fox: ["Yip yip!", "Hehe, my ears!", "Ack-ack!"],
  bunny: ["*nose wiggle*", "Binky!", "Hehe, soft!"],
  frog: ["Ribbit!", "Croak croak!", "Hehe, boing!"],
};
const TRICK = {
  jump: { ms: 1150, joy: true, says: null },
  wave: { ms: 1900, joy: false, says: ["Hi hi!", "Hello you!", "Oh hi there!"] },
  headbang: { ms: 1500, joy: true, says: ["♪ Rock on!", "♪ Head banger!", "♪ Turn it up!"], notes: true },
  dance: { ms: 1600, joy: true, says: ["♪ Dance party!", "♪ Wiggle wiggle!", "♪ Groovy!"], notes: true },
  spin: { ms: 1000, joy: true, says: ["Wheee!", "Spinny!", "Ta-da!"] },
  // the low-mood bag
  sulk: { ms: 2400, joy: false, says: ["Hmph.", "*pout*", "Not in the mood…"], prop: "cloud" },
  melt: { ms: 2100, joy: false, says: ["*melts*", "Ugh… can't get up…", "I'm a puddle now."] },
  sigh: { ms: 1900, joy: false, says: ["*sigh*…", "Haaah…", "Meh."], glyphs: ["…"] },
  shiver: { ms: 1300, joy: false, says: ["Brrr…", "*shiver*", "I feel wobbly…"] },
  tear: { ms: 2300, joy: false, says: ["*sniffle*", "A hug would help…", "*sniff sniff*"], prop: "tear" },
  fan: { ms: 1900, joy: false, says: ["So hot… water?", "Phew… I'm parched.", "Water… please…"], glyphs: ["drop"] },
};
export const TRICKS = ["jump", "wave", "headbang", "dance", "spin"];
export const LOW_TRICKS = ["sulk", "melt", "sigh", "shiver", "tear"];
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];

function floaters(svg, glyphs, n) {
  const puff = s("g", { class: "pet-puff" });
  for (let i = 0; i < n; i++) {
    const x = 40 + (i + 0.5) * (120 / n) + (Math.random() - 0.5) * 14, y = 52 + Math.random() * 26, size = 1.1 + Math.random() * 0.7;
    const g = glyphs[i % glyphs.length];
    const el = g === "heart"
      ? s("path", { d: "M0 6 C-12 -2 -6 -12 0 -5 C6 -12 12 -2 0 6 Z", fill: i % 2 ? "#ff8fab" : "#ff6f8e", transform: `translate(${x} ${y}) scale(${size})` })
      : g === "drop"
      ? s("path", { d: DROP, fill: i % 2 ? "#7cc4ff" : "#4aa8ff", transform: `translate(${x} ${y}) scale(${size})` })
      : s("text", { x, y, "font-size": 18 * size, fill: "#6b5cff", "font-weight": 700, "text-anchor": "middle" }, document.createTextNode(g));
    puff.append(s("g", { class: `pet-pop-wrap d${i}` }, el));
  }
  svg.append(puff);
  setTimeout(() => puff.remove(), 1500);
}

// Props for the low-mood tricks, drawn for the moment and removed after.
function rainCloud() {
  const drops = [80, 100, 120].map((x, i) => s("path", { class: `pet-rain d${i}`, d: `M${x} 30 l-2 7`, stroke: "#5aa9e6", "stroke-width": 3, "stroke-linecap": "round" }));
  return s("g", { class: "pet-prop pet-cloud" },
    s("path", { d: "M70 26 C64 26 62 16 70 14 C70 4 86 2 90 10 C94 0 112 2 112 12 C122 10 130 18 124 26 Z", fill: "#b9c2d6", stroke: "#8e98ae", "stroke-width": 2 }), ...drops);
}
function tearDrop(sp) {
  const { y, dx, r } = eyeAt(sp);
  return s("g", { class: "pet-prop pet-tear" }, s("path", { d: DROP, fill: "#8fd0ff", stroke: "#3d8fe0", "stroke-width": 1, transform: `translate(${100 + dx + r * 0.4} ${y + r + 6}) scale(.8)` }));
}

/** Do one trick (if it isn't already mid-trick). Returns false if it was busy. */
export function trick(svg, name) {
  const tr = TRICK[name];
  if (!svg || !tr || svg.dataset.busy) return false;
  svg.dataset.busy = name;
  svg.classList.add(`trick-${name}`);
  if (tr.joy) svg.classList.add("joy");
  if (tr.notes && !reduced()) floaters(svg, ["♪", "♫"], 3);
  if (tr.glyphs && !reduced()) floaters(svg, tr.glyphs, tr.glyphs[0] === "drop" ? 3 : 1);
  const prop = !reduced() && (tr.prop === "cloud" ? rainCloud() : tr.prop === "tear" ? tearDrop(svg.dataset.sp) : null);
  if (prop) svg.append(prop);
  setTimeout(() => { svg.classList.remove(`trick-${name}`, "joy"); delete svg.dataset.busy; if (prop) prop.remove(); }, tr.ms);
  return true;
}

const bandOf = (svg) => [...svg.classList].find((c) => /^pet-(thriving|happy|peckish|low)$/.test(c))?.slice(4) || "happy";
/** The moves that fit its mood: the happy bag, the low bag, or a mix when peckish; a thirsty pet fans itself too. */
function bagFor(svg) {
  const band = bandOf(svg);
  const bag = band === "low" ? [...LOW_TRICKS] : band === "peckish" ? ["wave", "jump", "sigh", "shiver", "sulk"] : [...TRICKS];
  if (svg.classList.contains("thirsty")) bag.push("fan", "fan");
  return bag;
}

/** A tap: a random trick (not the same twice running), hearts, and what it says. */
export function poke(svg, sp) {
  if (!svg) return null;
  const band = bandOf(svg);
  const options = bagFor(svg).filter((x) => x !== svg.dataset.last);
  const name = pick(options);
  svg.dataset.last = name;
  if (!trick(svg, name)) return null;
  if (TRICK[name].joy !== false || band !== "low") floaters(svg, ["heart"], band === "low" ? 2 : band === "thriving" ? 5 : 3);
  return TRICK[name].says ? pick(TRICK[name].says) : pick(SOUNDS[sp] || SOUNDS.owl);
}

/** A drink of water logged: a happy jump, a puff of droplets, and thanks. */
export function sip(svg) {
  if (!svg) return null;
  trick(svg, "jump");
  floaters(svg, ["drop"], 4);
  return pick(["Gulp gulp! Thank you!", "Ahh, refreshing!", "Mmm, water!", "Splash! I feel better already."]);
}

/** Left alone, the pet does a trick now and then: often when thriving, now and then when
 *  happy, and from its low-mood bag when peckish or low (a thirsty one fans itself). */
export function liven(svg) {
  if (!svg || reduced()) return;
  const band = bandOf(svg);
  const plan = { thriving: [4000, 8000, TRICKS], happy: [8000, 15000, ["wave", "jump", "dance"]], peckish: [11000, 18000, bagFor(svg)], low: [9000, 15000, bagFor(svg)] }[band];
  if (!plan) return;
  const [lo, hi, moves] = plan;
  const next = () => setTimeout(() => {
    if (!svg.isConnected) return; // re-rendered or closed: stop
    if (!document.hidden) trick(svg, pick(moves));
    next();
  }, lo + Math.random() * (hi - lo));
  setTimeout(() => { if (svg.isConnected) trick(svg, band === "low" ? pick(moves) : band === "peckish" ? "wave" : pick(moves)); }, 1200); // a hello on arrival
  next();
}
