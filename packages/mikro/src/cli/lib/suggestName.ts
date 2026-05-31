/**
 * Friendly adjective-animal name suggestion (e.g. "swift-cheetah"), derived
 * deterministically from a seed (the device id, or serial). Same board → same
 * suggestion every time, so it's stable and reproducible rather than a fresh
 * random name on each prompt. Output always matches the alias NAME_RE.
 */

const ADJECTIVES = [
  'swift',
  'calm',
  'bold',
  'brave',
  'clever',
  'eager',
  'gentle',
  'jolly',
  'keen',
  'lucky',
  'mighty',
  'nimble',
  'proud',
  'quick',
  'sleek',
  'witty',
  'bright',
  'brisk',
  'cosmic',
  'cozy',
  'dapper',
  'fuzzy',
  'grand',
  'happy',
  'humble',
  'lively',
  'mellow',
  'merry',
  'plucky',
  'quiet',
  'rapid',
  'snappy',
  'spry',
  'sunny',
  'tidy',
  'vivid',
  'zesty',
  'zippy',
  'fierce',
  'fluffy',
]

const ANIMALS = [
  'cheetah',
  'otter',
  'falcon',
  'lynx',
  'heron',
  'gecko',
  'tapir',
  'bison',
  'panda',
  'koala',
  'dingo',
  'lemur',
  'ocelot',
  'badger',
  'beaver',
  'wombat',
  'quokka',
  'narwhal',
  'walrus',
  'puffin',
  'raven',
  'magpie',
  'finch',
  'swallow',
  'ibis',
  'egret',
  'osprey',
  'kestrel',
  'marmot',
  'weasel',
  'ferret',
  'stoat',
  'jackal',
  'caracal',
  'serval',
  'okapi',
  'gazelle',
  'impala',
  'oryx',
  'kudu',
  'mongoose',
  'pangolin',
  'meerkat',
  'gibbon',
  'macaw',
  'toucan',
  'pelican',
  'manta',
  'marlin',
  'tarpon',
  'salmon',
  'mantis',
  'cricket',
  'hornet',
  'firefly',
  'robin',
  'sparrow',
  'wren',
  'thrush',
  'starling',
  'martin',
  'dove',
  'hoopoe',
  'oriole',
  'jay',
  'kite',
  'merlin',
  'owl',
  'stork',
  'crane',
  'flamingo',
  'lark',
  'plover',
  'tern',
  'kingfisher',
  'avocet',
  'curlew',
  'lapwing',
  'nuthatch',
]

/** FNV-1a 32-bit hash — deterministic and dependency-free. */
function hash(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A stable "adjective-animal" name for the given seed. */
export function suggestDeviceName(seed: string): string {
  const h = hash(seed)
  const adjective = ADJECTIVES[h % ADJECTIVES.length]
  const animal = ANIMALS[Math.floor(h / ADJECTIVES.length) % ANIMALS.length]
  return `${adjective}-${animal}`
}
