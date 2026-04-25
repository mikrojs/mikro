// Apple uses libkern/OSByteOrder.h instead of <endian.h> / <sys/endian.h>.
// nanocbor expects htobe16/32/64 and be16toh/32toh/64toh names; map them.
#pragma once
#include <libkern/OSByteOrder.h>

#define htobe16(x) OSSwapHostToBigInt16(x)
#define htobe32(x) OSSwapHostToBigInt32(x)
#define htobe64(x) OSSwapHostToBigInt64(x)
#define be16toh(x) OSSwapBigToHostInt16(x)
#define be32toh(x) OSSwapBigToHostInt32(x)
#define be64toh(x) OSSwapBigToHostInt64(x)
