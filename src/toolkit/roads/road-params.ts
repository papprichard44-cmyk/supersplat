// The settings of a road made by the Road Maker. Kept with the road (its
// generator params), so it can be edited and rebuilt until it is baked into
// splats.

type Rgb = [number, number, number];

type RoadStyle = 'dirt' | 'cobble' | 'pavers' | 'concrete' | 'custom';
type PaverPattern = 'running' | 'basket' | 'slabs';

type RoadParams = {
    id: string;                 // finds the road again across undo / redo
    style: RoadStyle;
    // the path: control points (x y z) in the road's own space
    points: number[];
    width: number;
    // the size of the pattern: stone, paver, joint spacing or grain, world units
    patternSize: number;
    pattern: PaverPattern;      // pavers only
    tint: Rgb;                  // over the style's own colours (white = as is)
    colorVariation: number;     // 0..1
    wear: number;               // 0..1: stains, dust, damp patches
    moss: number;               // 0..1: green in the joints (cobbles, pavers)
    edge: number;               // dirt: ragged edge width (share of the road width); stone: border row on / off (>0)
    curb: number;               // raised curb height, world units (0 = none)
    followGround: boolean;
    lift: number;               // above the ground, world units
    seed: number;
    // relief: the surface displaced by the texture's height map, 0 = flat
    relief: number;
    // custom texture: the picture (a data url, at most 1024 px), its height
    // map's scale (0 fine .. 1 coarse), dark = high instead of low, and
    // whether its edges are blended so it tiles without seams
    customTexture?: string;
    reliefDetail: number;
    reliefInvert: boolean;
    seamless: boolean;
    // ground heights found under the road (x z y, road space), so a rebuild
    // off screen still follows the ground
    ground?: number[];
};

type StyleInfo = {
    name: string;
    hint: string;
    patternLabel: string;
    // defaults, relative to the road width where it is a size
    patternSize: number;
    edge: number;
    curb: number;
    roughness: number;
};

const styles: Record<RoadStyle, StyleInfo> = {
    dirt: {
        name: 'Dirt trail',
        hint: 'Packed earth with pebbles and a ragged edge that blends into the ground.',
        patternLabel: 'Grain',
        patternSize: 1.2,
        edge: 0.18,
        curb: 0,
        roughness: 0.95
    },
    cobble: {
        name: 'Old cobblestone',
        hint: 'Irregular rounded setts in dark joints, worn and uneven, with a border row.',
        patternLabel: 'Stone size',
        patternSize: 0.07,
        edge: 1,
        curb: 0,
        roughness: 0.8
    },
    pavers: {
        name: 'Modern pavers',
        hint: 'Crisp concrete pavers in a regular pattern, with a soldier course along the edges.',
        patternLabel: 'Paver size',
        patternSize: 0.1,
        edge: 1,
        curb: 0,
        roughness: 0.75
    },
    concrete: {
        name: 'Concrete sidewalk',
        hint: 'Even, brushed concrete with cut joints, and a curb if you like.',
        patternLabel: 'Joint spacing',
        patternSize: 0.75,
        edge: 0,
        curb: 0.06,
        roughness: 0.85
    },
    custom: {
        name: 'Custom texture',
        hint: 'Your own picture, tiled along the road. Relief lifts its bright parts and sinks the dark ones (the joints), so it is not flat.',
        patternLabel: 'Texture size',
        patternSize: 1,
        edge: 0,
        curb: 0,
        roughness: 0.85
    }
};

// relief by default: enough to catch the light, not enough to notice as geometry
const defaultRelief: Record<RoadStyle, number> = { dirt: 0.35, cobble: 0.4, pavers: 0.3, concrete: 0.15, custom: 0.35 };

const defaultRoad = (width: number, style: RoadStyle = 'cobble'): RoadParams => ({
    id: '',
    style,
    points: [],
    width,
    patternSize: styles[style].patternSize * width,
    pattern: 'running',
    tint: [1, 1, 1],
    colorVariation: 0.5,
    wear: 0.3,
    moss: style === 'cobble' ? 0.25 : 0,
    edge: styles[style].edge,
    curb: styles[style].curb * width,
    followGround: true,
    lift: width * 0.008,
    seed: 1,
    relief: defaultRelief[style],
    reliefDetail: 0.4,
    reliefInvert: false,
    seamless: true
});

export { RoadParams, RoadStyle, PaverPattern, StyleInfo, styles, defaultRoad, defaultRelief, Rgb };
