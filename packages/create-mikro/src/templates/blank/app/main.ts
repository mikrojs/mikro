import { board, version } from "mikro/sys";

console.log(`Hello World from MikroJS v${version} (${board.name}@${board.chip}@${board.revision})`);
