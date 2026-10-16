import assert from 'node:assert/strict';
import test from 'node:test';

import { runFailureMessage, userErrorMessage } from './error-presentation.ts';

test('request errors are presented without leaking backend detail', () => {
  const error = { message: 'token=secret /gpfs/private Traceback SQLSTATE[42P01]', status: 500, code: null };
  const message = userErrorMessage(error);

  assert.equal(message, 'El servicio encontró un problema interno.');
  assert.doesNotMatch(message, /token|gpfs|traceback|sqlstate/i);
});

test('known run codes become actionable scientific workflow messages', () => {
  assert.equal(
    runFailureMessage('input_integrity_failed', 'sha256 mismatch at /private/input.fasta'),
    'Un archivo de entrada no superó la verificación de integridad.',
  );
});

test('unknown run failures never expose raw diagnostics', () => {
  const message = runFailureMessage('unknown_failure', 'Bearer abc.def.ghi');
  assert.equal(message, 'La ejecución no se completó. El equipo técnico puede consultar el diagnóstico interno.');
  assert.doesNotMatch(message, /bearer|abc\.def/i);
});
