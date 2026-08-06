import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, Quaternion, Vector3 } from 'three';
import { createHeadModelInstance } from './headModel.js';

const createSourceModel = () => {
  const source = new Group();
  source.position.set(7, -3, 2);

  const eyeControl = new Group();
  eyeControl.name = 'grp_eyeLeft_1';
  eyeControl.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), 0.2);
  source.add(eyeControl);

  const head = new Mesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial({ color: 0xff00ff }));
  head.name = 'mesh_2';
  head.morphTargetDictionary = { jawOpen: 0 };
  head.morphTargetInfluences = [0.25];
  source.add(head);

  const teeth = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: 0xffffff }));
  teeth.name = 'Object_13';
  teeth.position.y = -1;
  source.add(teeth);

  source.updateMatrixWorld(true);
  return { source, eyeControl, head };
};

test('creates a centered unit-sized head instance without mutating the cached source', () => {
  const { source, eyeControl, head } = createSourceModel();
  const sourcePosition = source.position.clone();
  const sourceEyeQuaternion = eyeControl.quaternion.clone();

  const model = createHeadModelInstance(source);
  const bounds = new Box3().setFromObject(model.scene);
  const center = bounds.getCenter(new Vector3());
  const size = bounds.getSize(new Vector3());

  assert.ok(center.length() < 1e-10);
  assert.ok(Math.abs(Math.max(size.x, size.y, size.z) - 1) < 1e-10);
  assert.ok(model.scene.position.equals(new Vector3()));
  assert.ok(model.scene.scale.equals(new Vector3(1, 1, 1)));
  assert.ok(source.position.equals(sourcePosition));
  assert.ok(eyeControl.quaternion.equals(sourceEyeQuaternion));
  assert.notEqual(model.headMesh, head);
  assert.equal(model.headMesh.geometry, head.geometry);
  assert.equal(model.headMesh.material, head.material);
  assert.deepEqual(model.meshNames, ['mesh_2', 'Object_13']);
  assert.equal(model.eyeControls.length, 1);
  assert.notEqual(model.eyeControls[0].object, eyeControl);
  assert.ok(model.eyeControls[0].baseQuaternion.equals(sourceEyeQuaternion));
});

test('isolates per-mount transforms, visibility, and morph state while sharing GPU assets', () => {
  const { source, head } = createSourceModel();
  const first = createHeadModelInstance(source);
  const second = createHeadModelInstance(source);

  first.scene.rotation.set(0.1, 0.2, 0.3);
  first.headMesh.visible = false;
  first.headMesh.morphTargetInfluences[0] = 0.9;
  first.eyeControls[0].object.quaternion.identity();

  assert.ok(second.scene.rotation.equals(source.rotation));
  assert.equal(second.headMesh.visible, true);
  assert.equal(second.headMesh.morphTargetInfluences[0], 0.25);
  assert.equal(head.morphTargetInfluences[0], 0.25);
  assert.equal(first.headMesh.geometry, second.headMesh.geometry);
  assert.equal(first.headMesh.material, second.headMesh.material);
  assert.notEqual(first.headMesh.morphTargetInfluences, second.headMesh.morphTargetInfluences);
});

test('rejects a model that does not satisfy the facial morph-target contract', () => {
  const source = new Group();
  source.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));

  assert.throws(() => createHeadModelInstance(source), /facial morph-target mesh/);
});

test('captures each eye base quaternion by value', () => {
  const { source } = createSourceModel();
  const model = createHeadModelInstance(source);
  const captured = model.eyeControls[0].baseQuaternion.clone();

  model.eyeControls[0].object.quaternion.copy(new Quaternion());

  assert.ok(model.eyeControls[0].baseQuaternion.equals(captured));
});
