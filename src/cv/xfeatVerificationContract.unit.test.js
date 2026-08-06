import assert from 'node:assert/strict';
import test from 'node:test';
import { assertXFeatVerificationContract } from './xfeatVerificationContract.js';

const acceptedRecovery = {
  featureCount: 500,
  recoveryInlierCount: 15,
  anchorError: 7.26,
};

test('XFeat verification contract owns feature coverage, recovery support, and anchor accuracy', () => {
  assert.deepEqual(assertXFeatVerificationContract(acceptedRecovery), acceptedRecovery);

  assert.throws(
    () => assertXFeatVerificationContract({ ...acceptedRecovery, featureCount: 499 }),
    /featureCount 499 is below 500/,
  );
  assert.throws(
    () => assertXFeatVerificationContract({ ...acceptedRecovery, recoveryInlierCount: 14 }),
    /recoveryInlierCount 14 is below 15/,
  );
  assert.throws(
    () => assertXFeatVerificationContract({ ...acceptedRecovery, anchorError: 7.51 }),
    /anchorError 7.51 exceeds 7.5/,
  );
});

test('XFeat verification contract rejects ambiguous or non-finite evidence', () => {
  assert.throws(() => assertXFeatVerificationContract(null), /must be an object/);
  assert.throws(
    () => assertXFeatVerificationContract({ ...acceptedRecovery, extra: true }),
    /fields must be anchorError, featureCount, recoveryInlierCount/,
  );
  assert.throws(
    () => assertXFeatVerificationContract({ ...acceptedRecovery, featureCount: 500.5 }),
    /featureCount must be a non-negative integer/,
  );
  assert.throws(
    () => assertXFeatVerificationContract({ ...acceptedRecovery, anchorError: Infinity }),
    /anchorError must be finite and non-negative/,
  );
});
