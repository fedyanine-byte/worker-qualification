// params.js — every tunable number for CapyUber: Autopilot
// Edited during calibration. Browser + Node compatible.

const PARAMS = {
  quarters: 8,

  // Required skill level per quarter (0-indexed quarter 0..7).
  // Peaks trimmed so a focused young worker can feasibly reach fit>=0.80 in 8 quarters;
  // most skills top at 2, a few at 3, the newcomers at 1. Total at Q8 = 16.
  requirements: {
    english:   [2, 2, 2, 2, 2, 2, 2, 2],
    digital:   [1, 1, 2, 2, 2, 2, 2, 2],
    data:      [0, 1, 1, 2, 2, 2, 2, 2],
    fleet:     [0, 1, 1, 1, 2, 2, 2, 2],
    teleop:    [0, 1, 1, 2, 2, 2, 2, 2],
    safety:    [1, 1, 1, 1, 2, 2, 2, 2],
    reg:       [0, 0, 0, 1, 1, 1, 1, 1],
    agents:    [0, 0, 0, 0, 0, 1, 1, 1],
    cyber:     [0, 0, 0, 0, 0, 0, 0, 1],
  },

  // ---- calibrated knobs (set by Monte Carlo to hit the target win rates) ----
  hoursMult: 0.8,      // scales every course's weekly hours
  rateMult: 1.4,       // scales every quarter's driving rate
  incomeSupportPerHour: 6,
  incomeSupportCapHrs: 12,
  childcareHours: 6,
  savingsLo: 1500,
  savingsHi: 15000,    // wide range; mean ~8k
  savingsPerYear: 0,   // no age-savings link, to keep the age gradient stark
  reqBump: {},         // host's live "raise a requirement" lever; honoured by requiredAt
  // Raise savingsHi toward 20000 to lift the no-policy win rate toward 30%,
  // at the cost of flattening the age/family gradient. See calibration note.

  // Net driving rate (eur/hour), falling as robotaxis spread. Per quarter.
  // Shown to players as the headline wage; rateMult below is the calibrated scaler.
  drivingRate: [9.0, 7.9, 7.0, 6.1, 5.4, 4.8, 4.2, 3.7],

  livingBase: 1200,          // eur/quarter (calibrated)
  livingPerFamilyLevel: 600, // eur/quarter per level
  weeksPerQuarter: 12,

  // Study capacity (hours/week)
  capacityBase: 24,
  capacityPenaltyPerDecadeOver35: 2,
  capacityHighFamilyPenalty: 3,   // if family level >= 2

  loadWarnThreshold: 1.0,   // dropout doubles above this
  loadBurnoutThreshold: 1.3, // one random course fails above this

  // Hiring
  interviewFit: 0.80,
  noAcademyFit: 0.90,       // "2 years experience" clause
  ageFilterThreshold: 45,   // hidden filter
  ageFilterFitPenalty: 0.05,

  // Obsolescence
  fleetV2Quarter: 5,        // Q6 (0-indexed 5): fleet -1 unless v2 update taken

  startingSafety: 1,

  // Life events
  eventChance: 0.30,

  // Fit-based: typical starter check
};

// Family load levels: index -> {freeHours, costLevel}
const FAMILY = [
  { name: 'none',    freeHours: 50, level: 0 },
  { name: '1 child', freeHours: 42, level: 1 },
  { name: '2+ kids', freeHours: 35, level: 2 },
  { name: 'parent',  freeHours: 30, level: 2 },
];

// Courses. gain: {skill: delta}. quarters: duration. fee. prereq: fn(skills,profile)->bool.
// available: earliest quarter index it appears (default 0).
const COURSES = [
  { id: 'state',        name: 'State retraining program', gain: { digital: 1 }, hrs: 10, quarters: 2, fee: 0,    drop: 0.10, req: () => true },
  { id: 'eng_evening',  name: 'English evening course',   gain: { english: 1 }, hrs: 6,  quarters: 2, fee: 400,  drop: 0.15, req: (s) => s.english <= 1 },
  { id: 'eng_intensive',name: 'English intensive',        gain: { english: 1 }, hrs: 10, quarters: 2, fee: 900,  drop: 0.15, req: (s) => s.english >= 2 },
  { id: 'data_mooc',    name: 'Online data course',       gain: { data: 1 },    hrs: 8,  quarters: 2, fee: 50,   drop: 0.35, req: (s) => s.english >= 2 },
  { id: 'data_boot',    name: 'Data bootcamp',            gain: { data: 2 },    hrs: 25, quarters: 1, fee: 3500, drop: 0.15, req: (s) => s.digital >= 2 && s.english >= 2 },
  { id: 'fleet_cert',   name: 'Fleet software certificate', gain: { fleet: 1 }, hrs: 10, quarters: 1, fee: 1200, drop: 0.10, req: (s) => s.digital >= 2 },
  { id: 'fleet_analytics', name: 'Fleet analytics',       gain: { fleet: 1, data: 1 }, hrs: 12, quarters: 1, fee: 1800, drop: 0.15, req: (s) => s.data >= 1 && s.fleet >= 1 },
  { id: 'teleop',       name: 'Teleoperation licence',    gain: { teleop: 2 },  hrs: 15, quarters: 1, fee: 2500, drop: 0.10, req: (s) => s.safety >= 1 && s.english >= 2 },
  { id: 'safety',       name: 'Safety & incident response', gain: { safety: 1 }, hrs: 6, quarters: 1, fee: 300,  drop: 0.05, req: () => true },
  { id: 'aiact',        name: 'EU AI Act essentials',     gain: { reg: 1 },     hrs: 5,  quarters: 1, fee: 250,  drop: 0.10, req: (s) => s.english >= 2 },
  { id: 'academy',      name: 'CapyUber Academy',         gain: { teleop: 1, fleet: 1, safety: 1 }, hrs: 15, quarters: 2, fee: 0, drop: 0.10,
    req: (s, p) => p.age <= 40 && p.education >= 1, academy: true, seats: 12 },
  { id: 'uni',          name: 'University module: Data & AI', gain: { data: 1, agents: 1 }, hrs: 10, quarters: 2, fee: 1400, drop: 0.15,
    req: (s, p) => p.education >= 2 || s.english >= 3 },
  { id: 'agents',       name: 'AI agents workshop',       gain: { agents: 1 },  hrs: 8,  quarters: 1, fee: 600,  drop: 0.15, available: 4, req: (s) => s.data >= 1 },
  { id: 'fleet_v2',     name: 'Fleet v2 update',          gain: { fleet: 1 },   hrs: 5,  quarters: 1, fee: 500,  drop: 0.05, available: 5, restore: true, req: (s) => s.fleet >= 1 },
  { id: 'cyber',        name: 'Cybersecurity basics',     gain: { cyber: 1 },   hrs: 6,  quarters: 1, fee: 400,  drop: 0.10, available: 6, req: (s) => s.digital >= 2 },
];

const SKILLS = ['english', 'digital', 'data', 'fleet', 'teleop', 'safety', 'reg', 'agents', 'cyber'];

const LIFE_EVENTS = [
  { id: 'sick',   hours: -6 },
  { id: 'repair', cash: -800 },
  { id: 'rent',   rentRise: 200 },
  { id: 'deact',  incomeMult: 0.75 },
  { id: 'family', cash: -500, hours: -4 },
];

if (typeof module !== 'undefined') module.exports = { PARAMS, FAMILY, COURSES, SKILLS, LIFE_EVENTS };
if (typeof window !== 'undefined') Object.assign(window, { PARAMS, FAMILY, COURSES, SKILLS, LIFE_EVENTS });
