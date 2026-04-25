// MSVC has no <endian.h>. Windows is always little-endian on the
// architectures we ship (x64, arm64), so map nanocbor's htobe*/be*toh to
// _byteswap_* intrinsics from <stdlib.h>.
#pragma once
#include <stdlib.h>

#define htobe16(x) _byteswap_ushort(x)
#define htobe32(x) _byteswap_ulong(x)
#define htobe64(x) _byteswap_uint64(x)
#define be16toh(x) _byteswap_ushort(x)
#define be32toh(x) _byteswap_ulong(x)
#define be64toh(x) _byteswap_uint64(x)
