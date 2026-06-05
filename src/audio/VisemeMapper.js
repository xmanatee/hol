import {
  STANDARD_VISEME_WEIGHTS,
  STANDARD_VISEMES,
  normalizeMorphName,
  resolveGenericTargetIndexMap,
  resolveGenericTargetOrder,
} from './facialRig.js';

const VISEME_NAME_PATTERNS = {
  M: ['mouthclose', 'lipsclose', 'closed', 'press', 'seal', 'mshape', 'bilabial', 'close', 'shut', 'mm'],
  A: ['mouthopen', 'jawopen', 'openwide', 'ashape', 'ahopen', 'surprise', 'open', 'wide', 'aa', 'ah', 'jaw'],
  E: ['mouthmid', 'eshape', 'ehopen', 'midopen', 'smileopen', 'mouthstretch', 'eh', 'mid', 'teeth'],
  I: ['mouthsmile', 'smile', 'grin', 'ishape', 'eeshape', 'narrowopen', 'teethshow', 'ii', 'ee', 'narrow'],
  O: ['mouthfunnel', 'oshape', 'ohopen', 'round', 'ovalopen', 'oo', 'oh', 'oval'],
  U: ['mouthpucker', 'pucker', 'ushape', 'ooshape', 'lipspucker', 'whistle', 'uu', 'kiss'],
};

export class VisemeMapper {
  constructor(morphTargetDictionary, options = {}) {
    this.morphDict = morphTargetDictionary || {};
    this.genericTargetOrder = options.genericTargetOrder || 'holBundledHead';
    this.genericBlendShapeNames = options.genericBlendShapeNames ||
      resolveGenericTargetOrder(this.genericTargetOrder);
    this.genericNameToIndex = options.genericBlendShapeNames
      ? Object.fromEntries(this.genericBlendShapeNames.map((name, index) => [name, index]))
      : resolveGenericTargetIndexMap(this.genericTargetOrder);
    this.visemeMap = this.createVisemeMapping();
  }

  createVisemeMapping() {
    const mapping = {};
    Object.keys(STANDARD_VISEMES).forEach(viseme => {
      mapping[viseme] = [];
    });

    Object.keys(this.morphDict).forEach(morphName => {
      const lowerName = normalizeMorphName(morphName);
      let bestMatch = null;
      let bestScore = 0;

      Object.entries(VISEME_NAME_PATTERNS).forEach(([viseme, keywords]) => {
        const score = keywords.reduce((sum, keyword) => {
          return sum + (lowerName.includes(keyword) ? keyword.length : 0);
        }, 0);

        if (score > bestScore) {
          bestScore = score;
          bestMatch = viseme;
        }
      });

      if (bestMatch && bestScore > 0) {
        this.addMapping(mapping, bestMatch, {
          name: morphName,
          index: this.morphDict[morphName],
          weight: 1,
        });
      }
    });

    if (this.hasGenericTargets()) {
      this.addGenericTargetMappings(mapping);
    }

    return mapping;
  }

  hasGenericTargets() {
    return this.genericBlendShapeNames.every((_, index) => {
      return Number.isInteger(this.morphDict[`target_${index}`]);
    });
  }

  addMapping(mapping, viseme, morph) {
    const alreadyMapped = mapping[viseme].some(existing => existing.index === morph.index);
    if (!alreadyMapped) {
      mapping[viseme].push(morph);
    }
  }

  addGenericTargetMappings(mapping) {
    Object.entries(STANDARD_VISEME_WEIGHTS).forEach(([viseme, weights]) => {
      weights.forEach(([blendShapeName, weight]) => {
        const genericIndex = this.genericNameToIndex[blendShapeName];
        const targetName = `target_${genericIndex}`;
        const index = this.morphDict[targetName];

        if (Number.isInteger(index)) {
          this.addMapping(mapping, viseme, {
            name: targetName,
            index,
            blendShapeName,
            weight,
          });
        }
      });
    });
  }

  resolveBlendShapeIndex(blendShapeName) {
    const genericIndex = this.genericNameToIndex[blendShapeName];
    if (Number.isInteger(genericIndex)) {
      const targetIndex = this.morphDict[`target_${genericIndex}`];
      if (Number.isInteger(targetIndex)) {
        return targetIndex;
      }
    }

    const normalizedBlendShape = normalizeMorphName(blendShapeName);
    const matchingEntry = Object.entries(this.morphDict).find(([morphName]) => {
      return normalizeMorphName(morphName) === normalizedBlendShape;
    });

    return matchingEntry ? matchingEntry[1] : null;
  }

  getBlendShapeNameForMorph(morphName) {
    if (morphName?.startsWith('target_')) {
      const targetIndex = Number.parseInt(morphName.slice(7), 10);
      return this.genericBlendShapeNames[targetIndex] || morphName;
    }

    return morphName;
  }

  getMorphIndicesForViseme(viseme) {
    return this.visemeMap[viseme] || [];
  }

  getAllMappedIndices() {
    const indices = new Set();
    Object.values(this.visemeMap).forEach(morphs => {
      morphs.forEach(morph => indices.add(morph.index));
    });
    return Array.from(indices);
  }
}
