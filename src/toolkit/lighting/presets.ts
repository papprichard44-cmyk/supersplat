import type { FixtureKind } from './fixtures';

// Classic film and photo lighting setups. Each light is placed around the
// subject relative to the camera:
//  azimuth   degrees around the subject, 0 = from the camera, + = camera right, 180 = behind
//  elevation degrees above the subject's centre (negative = from below)
//  distance  in subject sizes
//  power     stops (see Studio): 0 gives the subject a normal exposure from
//            one subject size away, every +1 doubles the light
// The descriptions are written for people who have never lit a set.

type PresetLight = {
    kind: FixtureKind;
    role: string;
    azimuth: number;
    elevation: number;
    distance: number;
    power: number;
    kelvin?: number;
    beam?: number;
    softEdge?: number;
    size?: number;          // multiplier on the fixture's usual size
    aspect?: number;
    spread?: number;
    shadows?: boolean;
};

type Preset = {
    id: string;
    label: string;
    description: string;
    // what the picture will look like, in one line
    expect: string;
    lights: PresetLight[];
    ambient: number;                        // ambient intensity
    ambientKelvin?: number;                 // colour of the ambient light
    ground?: number;                        // ground bounce, fraction of the ambient
    exposure?: number;                      // EV
};

const presets: Preset[] = [
    {
        id: 'three-point',
        label: 'Three-point (classic)',
        description: 'A soft key light to one side, a weaker fill light on the other side to soften the shadows, and a back light that outlines the subject.',
        expect: 'Balanced and natural, with clear shape and a subject that stands out from the background. Works for almost anything.',
        lights: [
            { kind: 'softbox', role: 'Key', azimuth: 40, elevation: 30, distance: 2.2, power: 2.3 },
            { kind: 'panel', role: 'Fill', azimuth: -50, elevation: 10, distance: 2.4, power: 0.9, size: 1.6 },
            { kind: 'fresnel', role: 'Back', azimuth: 155, elevation: 45, distance: 2.2, power: 2.4, beam: 20 }
        ],
        ambient: 0.04,
        ground: 0.5
    },
    {
        id: 'rembrandt',
        label: 'Rembrandt',
        description: 'One high key light at about 45 degrees and only a faint fill. Named after the painter: on a face it leaves a small triangle of light on the shadow-side cheek.',
        expect: 'Moody and sculpted, one side bright and the other falling into shadow. Dramatic but flattering.',
        lights: [
            { kind: 'softbox', role: 'Key', azimuth: 50, elevation: 45, distance: 2.0, power: 2.2, size: 0.8 },
            { kind: 'panel', role: 'Fill', azimuth: -40, elevation: 0, distance: 2.6, power: -0.6, size: 1.5 }
        ],
        ambient: 0.02,
        ground: 0.3
    },
    {
        id: 'butterfly',
        label: 'Butterfly (Paramount)',
        description: 'The key light sits straight in front, above the camera, with a soft fill from below. Classic Hollywood glamour light.',
        expect: 'Even and glamorous, short shadows below the shapes (a small butterfly-shaped shadow under a nose).',
        lights: [
            { kind: 'umbrella', role: 'Key', azimuth: 0, elevation: 50, distance: 2.0, power: 2.2, size: 0.7 },
            { kind: 'panel', role: 'Fill', azimuth: 0, elevation: -25, distance: 1.8, power: 0.4, size: 1.4 }
        ],
        ambient: 0.04,
        ground: 0.5
    },
    {
        id: 'split',
        label: 'Split',
        description: 'A single light from exactly one side and nothing else.',
        expect: 'Half of the subject bright, the other half in darkness. Strong, graphic, mysterious.',
        lights: [
            { kind: 'softbox', role: 'Key', azimuth: 90, elevation: 5, distance: 2.0, power: 2.0, size: 0.7 }
        ],
        ambient: 0.015,
        ground: 0.3
    },
    {
        id: 'clamshell',
        label: 'Clamshell (beauty)',
        description: 'One soft light above and one below the camera, like an open shell around the lens.',
        expect: 'Almost no shadows, smooth and even surfaces, catchy round highlights. Beauty and cosmetics look.',
        lights: [
            { kind: 'softbox', role: 'Top', azimuth: 0, elevation: 35, distance: 1.9, power: 2.0 },
            { kind: 'stripbox', role: 'Bottom', azimuth: 0, elevation: -30, distance: 1.7, power: 1.0, aspect: 0.25, size: 3 }
        ],
        ambient: 0.05,
        ground: 0.6
    },
    {
        id: 'high-key',
        label: 'High key',
        description: 'Lots of large, soft light from the front and both sides, and a bright surrounding.',
        expect: 'Bright, airy and low in contrast with very soft shadows. Clean commercial look.',
        lights: [
            { kind: 'umbrella', role: 'Key', azimuth: 20, elevation: 25, distance: 2.2, power: 2.4 },
            { kind: 'stripbox', role: 'Side left', azimuth: -70, elevation: 10, distance: 2.0, power: 1.4 },
            { kind: 'stripbox', role: 'Side right', azimuth: 70, elevation: 10, distance: 2.0, power: 1.4 }
        ],
        ambient: 0.35,
        ground: 0.8,
        exposure: 0.2
    },
    {
        id: 'low-key',
        label: 'Low key (noir)',
        description: 'One hard, narrow spotlight from the side, deep shadows everywhere else, and a thin rim light from behind to separate the subject from the dark.',
        expect: 'Dark and contrasty with crisp shadow edges. Film noir, thriller, luxury product.',
        lights: [
            { kind: 'fresnel', role: 'Key', azimuth: 65, elevation: 35, distance: 2.2, power: 2.6, beam: 14, softEdge: 0.5, kelvin: 3600 },
            { kind: 'fresnel', role: 'Rim', azimuth: -150, elevation: 30, distance: 2.2, power: 1.8, beam: 18 }
        ],
        ambient: 0.008,
        ground: 0.2
    },
    {
        id: 'rim',
        label: 'Rim / silhouette',
        description: 'Two lights behind the subject, to the left and right, pointing back towards the camera.',
        expect: 'Only the outline glows, the front stays dark. Silhouette, mystery, sci-fi.',
        lights: [
            { kind: 'fresnel', role: 'Rim left', azimuth: -150, elevation: 25, distance: 2.0, power: 2.6, beam: 22 },
            { kind: 'fresnel', role: 'Rim right', azimuth: 150, elevation: 25, distance: 2.0, power: 2.6, beam: 22 }
        ],
        ambient: 0.01,
        ground: 0.2
    },
    {
        id: 'product',
        label: 'Product (strip lights)',
        description: 'Two tall strip boxes left and right of the object and a soft light from above.',
        expect: 'Long clean highlight lines along glossy edges, soft shadows, a premium product look.',
        lights: [
            { kind: 'stripbox', role: 'Strip left', azimuth: -75, elevation: 15, distance: 2.0, power: 2.0 },
            { kind: 'stripbox', role: 'Strip right', azimuth: 75, elevation: 15, distance: 2.0, power: 2.0 },
            { kind: 'softbox', role: 'Top', azimuth: 0, elevation: 80, distance: 2.0, power: 1.5, size: 1.3 }
        ],
        ambient: 0.08,
        ground: 0.6
    },
    {
        id: 'golden-hour',
        label: 'Golden hour (outdoor)',
        description: 'A low, warm evening sun from the side and slightly behind, the blue sky filling the shadows.',
        expect: 'Warm glow, long soft-edged shadows, cool blue shadow tones. Cinematic outdoor mood.',
        lights: [
            { kind: 'sun', role: 'Sun', azimuth: 120, elevation: 12, distance: 3, power: 0.6, kelvin: 3200, size: 1.5 }
        ],
        ambient: 0.22,
        ambientKelvin: 9500,
        ground: 0.35
    },
    {
        id: 'noon',
        label: 'Midday sun (outdoor)',
        description: 'Hard sun from high above with a bright sky around.',
        expect: 'Short, dark, sharp shadows and strong contrast, like a clear summer noon.',
        lights: [
            { kind: 'sun', role: 'Sun', azimuth: 30, elevation: 68, distance: 3, power: 0.7, kelvin: 5600 }
        ],
        ambient: 0.28,
        ambientKelvin: 8000,
        ground: 0.4
    }
];

export { presets, Preset, PresetLight };
