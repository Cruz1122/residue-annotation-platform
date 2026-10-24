import { Cell } from 'molstar/lib/mol-math/geometry/spacegroup/cell.js';
import { Vec3 } from 'molstar/lib/mol-math/linear-algebra.js';

const BIOEMU_XTC_FORMAT = 'bioemu-xtc-display-cell';

function hasUsableCell(cell) {
  return Number.isFinite(cell?.volume)
    && cell.volume > 0
    && cell.toFractional
    && Array.from(cell.toFractional).every(Number.isFinite);
}

function displayCellForUnboxedFrames(frames) {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (const frame of frames) {
    if (frame.x.length !== frame.y.length || frame.x.length !== frame.z.length || frame.x.length === 0) {
      throw new Error('XTC contiene ejes de coordenadas incompatibles.');
    }
    for (let index = 0; index < frame.x.length; index += 1) {
      const x = frame.x[index];
      const y = frame.y[index];
      const z = frame.z[index];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error('XTC contiene coordenadas no finitas.');
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
  }

  const margin = Math.max(1, (maxX - minX) * 0.05, (maxY - minY) * 0.05, (maxZ - minZ) * 0.05);
  return Cell.create(
    Vec3.create(
      Math.max(1, maxX - minX + margin * 2),
      Math.max(1, maxY - minY + margin * 2),
      Math.max(1, maxZ - minZ + margin * 2),
    ),
    Vec3.create(Math.PI / 2, Math.PI / 2, Math.PI / 2),
  );
}

/**
 * Give Mol* an invertible, viewer-only cell for XTC frames without periodic boxes.
 * The BioEmu coordinates and frame metadata stay untouched; the cell is derived
 * from the coordinate extent solely because Mol* 5.12 requires an invertible one.
 */
export function repairUnboxedBioEmuCoordinates(coordinates) {
  if (!Array.isArray(coordinates?.frames) || coordinates.frames.length === 0) {
    throw new Error('Mol* no devolvió coordenadas de samples.xtc.');
  }

  const unboxedFrames = coordinates.frames.filter((frame) => !hasUsableCell(frame.cell));
  if (unboxedFrames.length === 0) return 0;

  const displayCell = displayCellForUnboxedFrames(unboxedFrames);
  for (const frame of unboxedFrames) frame.cell = displayCell;
  return unboxedFrames.length;
}

/**
 * Wrap Mol*'s installed XTC provider so its regular loadTrajectory API receives
 * usable cells for BioEmu's non-periodic coordinates.
 */
export async function loadBioEmuTrajectory(viewer, params) {
  const plugin = viewer?.plugin;
  if (!plugin?.dataFormats || !plugin?.state?.data?.cells) {
    throw new Error('Mol* no expuso el registro de formatos para cargar samples.xtc.');
  }

  const originalXtcProvider = plugin.dataFormats.get('xtc');
  const bioEmuXtcProvider = {
    ...originalXtcProvider,
    parse: async (activePlugin, data, providerParams) => {
      const coordinates = await originalXtcProvider.parse(activePlugin, data, providerParams);
      const coordinateCell = activePlugin.state.data.cells.get(coordinates.ref);
      if (!coordinateCell?.obj?.data) throw new Error('Mol* no pudo preparar las coordenadas de samples.xtc.');
      repairUnboxedBioEmuCoordinates(coordinateCell.obj.data);
      return coordinates;
    },
  };

  plugin.dataFormats.add(BIOEMU_XTC_FORMAT, bioEmuXtcProvider);
  try {
    return await viewer.loadTrajectory({
      ...params,
      coordinates: { ...params.coordinates, format: BIOEMU_XTC_FORMAT },
    });
  } finally {
    plugin.dataFormats.remove(BIOEMU_XTC_FORMAT);
  }
}
