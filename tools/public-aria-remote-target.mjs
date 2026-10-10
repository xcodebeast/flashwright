import assert from 'node:assert/strict';

/** Rejection needs a live remote iframe target, not a child world in which we execute. */
export function inspectRemoteAriaTarget(records, parentUrl, childUrl) {
  const frames = new Map();
  const sessions = new Map();
  const targets = new Map();
  const swappedFrames = new Set();
  for (const record of records) {
    if (record.kind !== 'frameMetadata') continue;
    const { method, parameters, sessionId } = record;
    if (method === 'Page.frameNavigated') {
      const frame = parameters.frame;
      frames.set(frame.id, { ...frames.get(frame.id), ...frame, sessionId });
      if (frame.parentId && frames.get(frame.parentId)?.sessionId === sessionId) swappedFrames.delete(frame.id);
    } else if (method === 'Page.frameAttached') {
      frames.set(parameters.frameId, { ...frames.get(parameters.frameId), id: parameters.frameId, parentId: parameters.parentFrameId });
    } else if (method === 'Page.frameDetached' && parameters.reason === 'swap') {
      swappedFrames.add(parameters.frameId);
    } else if (method === 'Page.frameDetached' && parameters.reason === 'remove') {
      const removed = new Set([parameters.frameId]);
      for (let changed = true; changed;) {
        changed = false;
        for (const frame of frames.values()) if (removed.has(frame.parentId) && !removed.has(frame.id)) { removed.add(frame.id); changed = true; }
      }
      for (const id of removed) { frames.delete(id); swappedFrames.delete(id); }
    } else if (method === 'Target.attachedToTarget') {
      sessions.set(parameters.sessionId, parameters.targetInfo.targetId);
      targets.set(parameters.targetInfo.targetId, { ...targets.get(parameters.targetInfo.targetId), ...parameters.targetInfo });
    } else if (method === 'Target.targetCreated') {
      targets.set(parameters.targetInfo.targetId, { ...parameters.targetInfo, discovered: true });
    } else if (method === 'Target.targetInfoChanged') {
      if (targets.has(parameters.targetInfo.targetId)) targets.set(parameters.targetInfo.targetId, { ...targets.get(parameters.targetInfo.targetId), ...parameters.targetInfo });
    } else if (method === 'Target.targetDestroyed') {
      targets.delete(parameters.targetId);
      for (const [id, targetId] of sessions) if (targetId === parameters.targetId) sessions.delete(id);
    } else if (method === 'Target.detachedFromTarget') {
      const targetId = sessions.get(parameters.sessionId);
      sessions.delete(parameters.sessionId);
      if (!targets.get(targetId)?.discovered && ![...sessions.values()].includes(targetId)) targets.delete(targetId);
    }
  }
  const parents = [...frames.values()].filter(frame => frame.url === parentUrl && !frame.parentId);
  assert.equal(parents.length, 1, 'expected one live parent document');
  const parent = parents[0];
  const children = [...targets.values()].filter(target => target.type === 'iframe' && target.url === childUrl &&
    frames.get(target.targetId)?.parentId === parent.id && swappedFrames.has(target.targetId));
  assert.equal(children.length, 1, 'expected one live remote iframe target linked to the swapped child');
  const target = children[0];
  const childSessions = [...sessions].filter(([, targetId]) => targetId === target.targetId);
  assert.ok(childSessions.length <= 1, 'ambiguous attached child sessions');
  const childSessionId = childSessions[0]?.[0] ?? null;
  assert.equal(typeof parent.sessionId, 'string');
  assert.notEqual(childSessionId, parent.sessionId);
  if (target.parentFrameId !== undefined) assert.equal(target.parentFrameId, parent.id);
  return { placement: 'out-of-process', parentFrameId: parent.id, parentSessionId: parent.sessionId,
    childFrameId: target.targetId, childSessionId, discovered: target.discovered === true,
    scope: 'Live remote target and process swap only; no child-world execution claim' };
}
