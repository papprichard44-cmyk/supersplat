import { Ray, Vec3 } from 'playcanvas';

import { ElementType } from '../element';
import type { Scene } from '../scene';
import { Splat } from '../splat';
import type { MeshRaycaster } from './mesh-raycast';

// The surface under the cursor - splats or meshes, whichever is nearer - for
// the brushes that put things onto the scene (stamp brush, plant placement).

const MAX_SAMPLES = 240;            // surface probes per stroke
const NORMAL_PROBE = 6;             // px: offset of the two extra probes the surface normal is taken from

type Hit = { position: Vec3, normal: Vec3 };

const createSurfaceProbe = (scene: Scene, raycaster: MeshRaycaster) => {
    const splats = () => scene.getElementsByType(ElementType.splat) as Splat[];


    const snapshotPose = () => ({
        position: scene.camera.mainCamera.getPosition().clone(),
        rotation: scene.camera.mainCamera.getRotation().clone(),
        orthoHeight: scene.camera.camera.orthoHeight,
        near: scene.camera.near,
        far: scene.camera.far
    });

    // the nearest surface - splat or mesh - under each viewport pixel. With
    // `normals` every pixel is probed three times and splat hits get a normal
    // from the two neighbouring probes; mesh hits have their exact normal.
    const ray = new Ray();
    const probe = async (pixels: { x: number, y: number }[], normals: boolean): Promise<(Hit | null)[]> => {
        // without `normals`, splat hits face the camera
        const width = scene.canvas.clientWidth || 1;
        const height = scene.canvas.clientHeight || 1;
        const canvas = scene.canvas;
        const points: { x: number, y: number }[] = [];
        pixels.forEach(({ x, y }) => {
            points.push({ x: x / width, y: y / height });
            if (normals) {
                points.push({ x: (x + NORMAL_PROBE) / width, y: y / height });
                points.push({ x: x / width, y: (y + NORMAL_PROBE) / height });
            }
        });

        // mesh rays under the current camera, before anything can move it
        await raycaster.update();
        const pose = snapshotPose();
        const rays = points.map(({ x, y }) => {
            scene.camera.getRay(x * canvas.clientWidth, y * canvas.clientHeight, ray);
            const direction = ray.direction.clone().normalize();
            const origin = ray.origin.clone();
            return { origin, direction, mesh: raycaster.cast(origin, direction) };
        });

        const visible = splats().filter(splat => splat.visible);
        const splatHits = visible.length ? await scene.camera.intersectMany(points, visible, pose) : points.map((): null => null);

        // a pixel the splats barely cover reads back an unstable depth, which can
        // land far off in space: only trust hits inside the scene's bounds
        const bound = scene.bound;
        const slack = bound ? Math.max(bound.halfExtents.x, bound.halfExtents.y, bound.halfExtents.z) * 0.1 + 1e-3 : 0;
        const inScene = (p: Vec3) => !bound || (
            Math.abs(p.x - bound.center.x) <= bound.halfExtents.x + slack &&
            Math.abs(p.y - bound.center.y) <= bound.halfExtents.y + slack &&
            Math.abs(p.z - bound.center.z) <= bound.halfExtents.z + slack
        );

        const nearest = rays.map(({ origin, mesh }, i) => {
            const s = splatHits[i] && inScene(splatHits[i].position) ? splatHits[i] : null;
            const st = s ? s.position.distance(origin) : Infinity;
            if (mesh && mesh.t <= st) return { position: mesh.position, normal: mesh.normal, mesh: true };
            return s ? { position: s.position, normal: origin.clone().sub(s.position).normalize(), mesh: false } : null;
        });

        if (!normals) return nearest;

        const camera = scene.camera.mainCamera.getPosition();
        return pixels.map((_, i) => {
            const hit = nearest[i * 3];
            if (!hit) return null;
            if (hit.mesh) return hit;
            const toEye = camera.clone().sub(hit.position).normalize();
            const hx = nearest[i * 3 + 1];
            const hy = nearest[i * 3 + 2];
            let normal = toEye;
            if (hx && hy) {
                const n = new Vec3().cross(hx.position.clone().sub(hit.position), hy.position.clone().sub(hit.position)).normalize();
                if (n.dot(toEye) < 0) n.mulScalar(-1);
                // a normal almost edge-on to the view comes from a depth jump
                // between the probes, not from the surface
                if (n.dot(toEye) > 0.17) normal = n;
            }
            return { position: hit.position, normal };
        });
    };

    // evenly resample a stroke given in viewport pixels
    const resample = (stroke: { x: number, y: number }[]) => {
        const lengths = [0];
        for (let i = 1; i < stroke.length; ++i) {
            lengths.push(lengths[i - 1] + Math.hypot(stroke[i].x - stroke[i - 1].x, stroke[i].y - stroke[i - 1].y));
        }
        const total = lengths[lengths.length - 1];
        const numSamples = Math.max(1, Math.min(MAX_SAMPLES, Math.round(total / 3) + 1));
        const samples: { x: number, y: number }[] = [];
        let segment = 0;
        for (let i = 0; i < numSamples; ++i) {
            const at = numSamples === 1 ? 0 : total * i / (numSamples - 1);
            while (segment < stroke.length - 2 && lengths[segment + 1] < at) segment++;
            const span = (lengths[segment + 1] ?? 0) - lengths[segment];
            const f = span > 0 ? (at - lengths[segment]) / span : 0;
            const a = stroke[segment];
            const b = stroke[Math.min(segment + 1, stroke.length - 1)];
            samples.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
        }
        return samples;
    };

    return { probe, resample };
};

export { createSurfaceProbe, Hit };
