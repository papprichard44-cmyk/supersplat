import { ElementType } from '../element';
import type { Scene } from '../scene';
import { Splat } from '../splat';

import type { ToolkitContext, ToolkitModule } from './index';

// Splat layers generated from meshes opt out of the renderer's size cull (see
// Splat.noSizeCull). The flag is not part of the splat data, so it is stored
// in the project file by layer name and restored on load.

let scene: Scene | null = null;

const splats = () => (scene?.getElementsByType(ElementType.splat) ?? []) as Splat[];

const generatedLayersModule: ToolkitModule = {
    id: 'generatedLayers',
    init: (ctx: ToolkitContext) => {
        scene = ctx.scene;
    },
    serialize: () => splats().filter(splat => splat.noSizeCull).map(splat => splat.name),
    deserialize: (data) => {
        const names = new Set(Array.isArray(data) ? data as string[] : []);
        splats().forEach((splat) => {
            if (names.has(splat.name)) {
                splat.noSizeCull = true;
            }
        });
    }
};

export { generatedLayersModule };
