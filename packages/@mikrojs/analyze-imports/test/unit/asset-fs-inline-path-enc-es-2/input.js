import fs from 'fs';
import path from 'path';

console.log(fs.readFileSync(new URL('asset.txt', import.meta.url), 'utf8'));