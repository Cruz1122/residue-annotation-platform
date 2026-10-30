import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EXTERNAL_TRACKING_STALE_AFTER_MS,
  externalTrackingIsUnavailable,
  runStagePublicationSignature,
  runUpdatesFinished,
} from './run-updates.js';

test('terminal external runs keep refreshing until remote result sync finishes', () => {
  assert.equal(runUpdatesFinished({
    status: 'success',
    external_tracking: { tracking_active: true },
  }), false);
});

test('terminal runs stop refreshing after remote tracking completes', () => {
  assert.equal(runUpdatesFinished({
    status: 'success',
    external_tracking: { tracking_active: false },
  }), true);
});

test('nonterminal runs continue refreshing without external tracking', () => {
  assert.equal(runUpdatesFinished({ status: 'running', external_tracking: null }), false);
});

test('active external tracking reports a stale connection after missed refreshes', () => {
  const now = Date.parse('2026-10-26T23:53:00Z');
  const tracking = {
    tracking_active: true,
    connection_status: 'connected',
    last_synced_at: new Date(now - EXTERNAL_TRACKING_STALE_AFTER_MS - 1).toISOString(),
  };

  assert.equal(externalTrackingIsUnavailable(tracking, now), true);
});

test('active external tracking reports an explicit MN5 connection failure', () => {
  assert.equal(externalTrackingIsUnavailable({
    tracking_active: true,
    connection_status: 'unavailable',
    last_synced_at: '2026-10-26T23:52:00Z',
  }), true);
});

test('fresh active external tracking reports artifact publication sync', () => {
  const now = Date.parse('2026-10-26T23:53:00Z');
  const tracking = {
    tracking_active: true,
    connection_status: 'connected',
    sync_error_code: 'result_publication_pending',
    last_synced_at: new Date(now - 15_000).toISOString(),
  };

  assert.equal(externalTrackingIsUnavailable(tracking, now), false);
});

test('completed tracking is not marked disconnected because its timestamp is old', () => {
  const tracking = { tracking_active: false, connection_status: 'connected', last_synced_at: null };

  assert.equal(externalTrackingIsUnavailable(tracking), false);
});

test('stage publication signatures change when a watched stage publishes an artifact', () => {
  const before = {
    stages: [{ id: 'structural_contacts', status: 'success', stage_result_id: null, artifacts: [] }],
  };
  const after = {
    stages: [{
      id: 'structural_contacts',
      status: 'success',
      stage_result_id: 'stage-result-1',
      artifacts: [{ id: 'artifact-1', artifact_type: 'arpeggio_json', sha256: 'abc' }],
    }],
  };

  assert.notEqual(
    runStagePublicationSignature(before, ['structural_contacts']),
    runStagePublicationSignature(after, ['structural_contacts']),
  );
});

test('stage publication signatures ignore artifacts from unrelated stages', () => {
  const before = { stages: [{ id: 'structural_contacts', status: 'running', artifacts: [] }] };
  const after = {
    stages: [
      { id: 'structural_contacts', status: 'running', artifacts: [] },
      { id: 'protein_identity', status: 'success', artifacts: [{ id: 'identity', artifact_type: 'protein_identity' }] },
    ],
  };

  assert.equal(
    runStagePublicationSignature(before, ['structural_contacts']),
    runStagePublicationSignature(after, ['structural_contacts']),
  );
});
