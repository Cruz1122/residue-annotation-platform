export async function updateBioEmuFrame({ index, commitModelIndex, getSelectedPosition, selectResidue, followCameraTarget, isActive = () => true }) {
  await commitModelIndex(index);
  if (!isActive()) return;
  const selectedPosition = getSelectedPosition();
  if (Number.isInteger(selectedPosition)) {
    if (selectResidue(selectedPosition, { focus: false }) === false) {
      throw new Error('La selección actual dejó de corresponder con la topología PDB.');
    }
  }
  followCameraTarget?.({ selectedPosition });
}

export function followBioEmuCameraTarget({ camera, structure, selectedLoci, lociApi, followSelection }) {
  let target;

  if (followSelection) {
    if (!lociApi?.is?.(selectedLoci) || lociApi.isEmpty(selectedLoci)) return false;
    target = lociApi.getBoundingSphere(selectedLoci)?.center;
  } else {
    target = structure?.boundary?.sphere?.center;
  }

  if (!target || target.length < 3 || !Number.isFinite(target[0]) || !Number.isFinite(target[1]) || !Number.isFinite(target[2])) return false;
  if (typeof camera?.setTranslation !== 'function') return false;

  // Move the camera target and position together, preserving its orientation and zoom.
  camera.setTranslation(target, 0);
  return true;
}
