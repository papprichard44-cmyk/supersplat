import type { Container } from '@playcanvas/pcui';

import type { Events } from '../events';
import type { Scene } from '../scene';
import { exportCompareModule } from './export-compare';
import { generatedLayersModule } from './generated-layers';
import { generatorsModule } from './generators';
import { inspectorModule } from './inspector';
import { studioModule } from './lighting/studio';
import { meshPrimitivesModule } from './mesh-primitives';
import { roadsModule } from './roads/roads';
import { sceneMeshesModule } from './scene-meshes';
import { skyModule } from './sky/sky';
import { splatInspectorModule } from './splat-inspector';
import { stampBrushModule } from './stamp-brush';
import { vegetationModule } from './vegetation/vegetation';
import type { ToolManager } from '../tools/tool-manager';
import type { Tooltips } from '../ui/tooltips';

// Everything the toolkit adds on top of upstream SuperSplat lives in this
// directory. Upstream files only gain the hooks that call into it (main.ts,
// doc.ts), which keeps merges from playcanvas/supersplat cheap.

type ToolkitContext = {
    events: Events;
    scene: Scene;
    toolManager: ToolManager;
    canvasContainer: Container;
    // overlay the viewport tools draw into and take their pointer input from
    toolsContainer: Container;
    tooltips: Tooltips;
};

// A toolkit feature. New features - including wrappers around community tools -
// are added by writing a module and listing it below.
interface ToolkitModule {
    id: string;
    init(ctx: ToolkitContext): void;
    // state stored in / restored from the project file (.ssproj)
    serialize?(): unknown;
    deserialize?(data: unknown): void | Promise<void>;
}

const modules: ToolkitModule[] = [
    inspectorModule,
    meshPrimitivesModule,
    splatInspectorModule,
    sceneMeshesModule,
    studioModule,
    vegetationModule,
    roadsModule,
    skyModule,
    generatorsModule,
    generatedLayersModule,
    exportCompareModule,
    stampBrushModule
];

const initToolkit = (ctx: ToolkitContext) => {
    modules.forEach(module => module.init(ctx));

    ctx.events.function('docSerialize.toolkit', () => {
        const result: Record<string, unknown> = {};
        modules.forEach((module) => {
            if (module.serialize) {
                result[module.id] = module.serialize();
            }
        });
        return result;
    });

    ctx.events.function('docDeserialize.toolkit', async (data: Record<string, unknown> | undefined) => {
        for (const module of modules) {
            if (module.deserialize) {
                await module.deserialize(data?.[module.id]);
            }
        }
    });
};

export { initToolkit, ToolkitContext, ToolkitModule };
