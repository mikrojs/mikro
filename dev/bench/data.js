window.BENCHMARK_DATA = {
  "lastUpdate": 1777158260191,
  "repoUrl": "https://github.com/mikrojs/mikrojs",
  "entries": {
    "Benchmark": [
      {
        "commit": {
          "author": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "committer": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "distinct": true,
          "id": "c6186a925722eb5d075f34a24654555de2b4ff6e",
          "message": "refactor: migrate benchmark site from gh-pages to cloudflare workers with bench-data branch",
          "timestamp": "2026-04-25T18:16:03.037Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/c6186a925722eb5d075f34a24654555de2b4ff6e"
        },
        "date": 1777140963037,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "committer": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "distinct": true,
          "id": "ea63ab3f5d098baa02eb6c011495410c529dd599",
          "message": "refactor: migrate benchmark site from gh-pages to cloudflare workers with bench-data branch",
          "timestamp": "2026-04-25T18:21:37.903Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/ea63ab3f5d098baa02eb6c011495410c529dd599"
        },
        "date": 1777141297903,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "committer": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "distinct": true,
          "id": "46c08ec1774f67ae8aa33c3e1e8814387de4013a",
          "message": "docs: add npmx.dev registry badges to readme",
          "timestamp": "2026-04-25T21:01:22.514Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/46c08ec1774f67ae8aa33c3e1e8814387de4013a"
        },
        "date": 1777150882514,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "committer": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "distinct": true,
          "id": "340f75b5a586b2529fa816346271ea2d5083c8c9",
          "message": "chore(ci): release automation (#1)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-04-25T22:18:04.496Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/340f75b5a586b2529fa816346271ea2d5083c8c9"
        },
        "date": 1777155484496,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "committer": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "distinct": true,
          "id": "6a55e284fb7e3739282d727703afa3c856377ebe",
          "message": "feat(release): bootstrap first release\n\nRelease-As: 0.0.1\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-04-25T22:28:02.923Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/6a55e284fb7e3739282d727703afa3c856377ebe"
        },
        "date": 1777156082923,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "github-actions[bot]",
            "email": "41898282+github-actions[bot]@users.noreply.github.com",
            "username": ""
          },
          "committer": {
            "name": "github-actions[bot]",
            "email": "41898282+github-actions[bot]@users.noreply.github.com",
            "username": ""
          },
          "distinct": true,
          "id": "fb47d136409b50f9e3aaa5fc92cfd75fdb4a75f5",
          "message": "chore: release main (#2)\n\nCo-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
          "timestamp": "2026-04-25T22:33:56.303Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/fb47d136409b50f9e3aaa5fc92cfd75fdb4a75f5"
        },
        "date": 1777156436303,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "committer": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "distinct": true,
          "id": "b89af1d0403f8e975d95e361782ef3f030c1d3b5",
          "message": "fix(build): unblock native prebuilds on macOS and Windows CI\n\ncmake-js builds in the release matrix fail on platforms other than\nLinux because the build system makes Linux-shaped assumptions:\n\n- macOS: nanocbor's NANOCBOR_BYTEORDER_HEADER was set to \"sys/endian.h\",\n  which Apple SDKs don't reliably ship. Add byteorder_apple.h, a thin\n  shim that maps htobe*/be*toh to OSSwap* macros from\n  <libkern/OSByteOrder.h>.\n- Windows: cc -o qjsc emits qjsc.exe, but CMake and the JS-side\n  qjscPath both looked for \"qjsc\" without the suffix, so the build\n  would loop on rebuilds and CMake would error before configure\n  finished. Make the path platform-aware in postinstall.js,\n  index.js, and quickjs.cmake.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-04-25T22:54:15.392Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/b89af1d0403f8e975d95e361782ef3f030c1d3b5"
        },
        "date": 1777157655392,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "github-actions[bot]",
            "email": "41898282+github-actions[bot]@users.noreply.github.com",
            "username": ""
          },
          "committer": {
            "name": "github-actions[bot]",
            "email": "41898282+github-actions[bot]@users.noreply.github.com",
            "username": ""
          },
          "distinct": true,
          "id": "62ad03367e9d4c323b9ad2959773c5b02672596b",
          "message": "chore: release main (#3)\n\nCo-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
          "timestamp": "2026-04-25T22:56:47.383Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/62ad03367e9d4c323b9ad2959773c5b02672596b"
        },
        "date": 1777157807383,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "committer": {
            "name": "Bjørge Næss",
            "email": "bjoerge@gmail.com",
            "username": ""
          },
          "distinct": true,
          "id": "fb7e3f9701a3f388936753bd6f39f2eff467e004",
          "message": "ci(firmware): drop push-to-main trigger to save routine CI time\n\nBuilding four ESP-IDF chip firmwares on every main push burned ~30\nminutes of CI per merge with no consumer for the artifacts -- release\nbundles come from release.yml and ad-hoc flashes are explicitly\ndispatched per SHA. Keep PR-label and workflow_dispatch.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>",
          "timestamp": "2026-04-25T23:03:37.694Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/fb7e3f9701a3f388936753bd6f39f2eff467e004"
        },
        "date": 1777158217694,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      },
      {
        "commit": {
          "author": {
            "name": "github-actions[bot]",
            "email": "41898282+github-actions[bot]@users.noreply.github.com",
            "username": ""
          },
          "committer": {
            "name": "github-actions[bot]",
            "email": "41898282+github-actions[bot]@users.noreply.github.com",
            "username": ""
          },
          "distinct": true,
          "id": "d8b3789065ac8dfec9493e5b508baf230b028e1b",
          "message": "chore: release main (#4)\n\nCo-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
          "timestamp": "2026-04-25T23:04:20.191Z",
          "tree_id": "",
          "url": "https://github.com/mikrojs/mikrojs/commit/d8b3789065ac8dfec9493e5b508baf230b028e1b"
        },
        "date": 1777158260191,
        "tool": "customSmallerIsBetter",
        "benches": [
          {
            "name": "runtime_init — Total Memory",
            "unit": "KB",
            "value": 97.02,
            "extra": "bytes=99347 mallocs=1156 obj=206/14832 shape=112/18960 prop=993/17216 str=5/267 atom=600/37833 jsfunc=1/137 pc2line=0/0 save_weakref=3244 save_shape=896"
          },
          {
            "name": "runtime_init — Bytecode",
            "unit": "KB",
            "value": 0.01,
            "extra": "js_func_code_size=14 bytes, 1 functions"
          },
          {
            "name": "runtime_init — Live Allocations",
            "unit": "count",
            "value": 1156,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ result — Total Memory",
            "unit": "KB",
            "value": 101.84,
            "extra": "bytes=104289 mallocs=1234 obj=219/15768 shape=115/19264 prop=1020/17792 str=11/589 atom=615/38508 jsfunc=6/1202 pc2line=3/6 save_weakref=3380 save_shape=920"
          },
          {
            "name": "+ result — Bytecode",
            "unit": "KB",
            "value": 0.2,
            "extra": "js_func_code_size=208 bytes, 6 functions"
          },
          {
            "name": "+ result — Live Allocations",
            "unit": "count",
            "value": 1234,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sys — Total Memory",
            "unit": "KB",
            "value": 114,
            "extra": "bytes=116738 mallocs=1447 obj=256/18432 shape=121/20152 prop=1121/19616 str=25/1296 atom=647/39991 jsfunc=23/4371 pc2line=18/59 save_weakref=3712 save_shape=968"
          },
          {
            "name": "+ sys — Bytecode",
            "unit": "KB",
            "value": 0.66,
            "extra": "js_func_code_size=673 bytes, 23 functions"
          },
          {
            "name": "+ sys — Live Allocations",
            "unit": "count",
            "value": 1447,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stdio — Total Memory",
            "unit": "KB",
            "value": 120.91,
            "extra": "bytes=123809 mallocs=1554 obj=280/20160 shape=126/20672 prop=1176/20624 str=31/1617 atom=655/40402 jsfunc=31/5887 pc2line=23/90 save_weakref=3864 save_shape=1008"
          },
          {
            "name": "+ stdio — Bytecode",
            "unit": "KB",
            "value": 0.9,
            "extra": "js_func_code_size=921 bytes, 31 functions"
          },
          {
            "name": "+ stdio — Live Allocations",
            "unit": "count",
            "value": 1554,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ cbor — Total Memory",
            "unit": "KB",
            "value": 123.5,
            "extra": "bytes=126468 mallocs=1599 obj=290/20880 shape=126/20672 prop=1196/21072 str=37/1937 atom=656/40455 jsfunc=33/6193 pc2line=23/90 save_weakref=3932 save_shape=1008"
          },
          {
            "name": "+ cbor — Bytecode",
            "unit": "KB",
            "value": 0.91,
            "extra": "js_func_code_size=933 bytes, 33 functions"
          },
          {
            "name": "+ cbor — Live Allocations",
            "unit": "count",
            "value": 1599,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ schema — Total Memory",
            "unit": "KB",
            "value": 135.36,
            "extra": "bytes=138607 mallocs=1755 obj=315/22680 shape=127/20768 prop=1259/22224 str=43/2259 atom=700/42696 jsfunc=50/9618 pc2line=27/273 save_weakref=4232 save_shape=1016"
          },
          {
            "name": "+ schema — Bytecode",
            "unit": "KB",
            "value": 2.61,
            "extra": "js_func_code_size=2677 bytes, 50 functions"
          },
          {
            "name": "+ schema — Live Allocations",
            "unit": "count",
            "value": 1755,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ env — Total Memory",
            "unit": "KB",
            "value": 138.96,
            "extra": "bytes=142292 mallocs=1810 obj=327/23544 shape=128/20872 prop=1284/22752 str=49/2578 atom=704/42921 jsfunc=55/10447 pc2line=29/279 save_weakref=4320 save_shape=1024"
          },
          {
            "name": "+ env — Bytecode",
            "unit": "KB",
            "value": 2.72,
            "extra": "js_func_code_size=2787 bytes, 55 functions"
          },
          {
            "name": "+ env — Live Allocations",
            "unit": "count",
            "value": 1810,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ fs — Total Memory",
            "unit": "KB",
            "value": 147.02,
            "extra": "bytes=150551 mallocs=1946 obj=355/25560 shape=129/21104 prop=1358/24096 str=55/2896 atom=711/43263 jsfunc=67/12879 pc2line=39/324 save_weakref=4484 save_shape=1032"
          },
          {
            "name": "+ fs — Bytecode",
            "unit": "KB",
            "value": 3.17,
            "extra": "js_func_code_size=3241 bytes, 67 functions"
          },
          {
            "name": "+ fs — Live Allocations",
            "unit": "count",
            "value": 1946,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ reader — Total Memory",
            "unit": "KB",
            "value": 158.34,
            "extra": "bytes=162143 mallocs=2059 obj=372/26784 shape=132/21448 prop=1398/24880 str=61/3218 atom=733/47352 jsfunc=80/15848 pc2line=48/456 save_weakref=4664 save_shape=1056"
          },
          {
            "name": "+ reader — Bytecode",
            "unit": "KB",
            "value": 4.17,
            "extra": "js_func_code_size=4269 bytes, 80 functions"
          },
          {
            "name": "+ reader — Live Allocations",
            "unit": "count",
            "value": 2059,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ stream — Total Memory",
            "unit": "KB",
            "value": 164.7,
            "extra": "bytes=168656 mallocs=2140 obj=387/27864 shape=134/21648 prop=1425/25536 str=67/3540 atom=746/48075 jsfunc=88/17648 pc2line=54/553 save_weakref=4800 save_shape=1072"
          },
          {
            "name": "+ stream — Bytecode",
            "unit": "KB",
            "value": 4.98,
            "extra": "js_func_code_size=5096 bytes, 88 functions"
          },
          {
            "name": "+ stream — Live Allocations",
            "unit": "count",
            "value": 2140,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pin — Total Memory",
            "unit": "KB",
            "value": 171.54,
            "extra": "bytes=175659 mallocs=2257 obj=408/29376 shape=137/22008 prop=1479/26528 str=73/3859 atom=763/48917 jsfunc=95/19035 pc2line=59/563 save_weakref=4976 save_shape=1096"
          },
          {
            "name": "+ pin — Bytecode",
            "unit": "KB",
            "value": 5.18,
            "extra": "js_func_code_size=5305 bytes, 95 functions"
          },
          {
            "name": "+ pin — Live Allocations",
            "unit": "count",
            "value": 2257,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sleep — Total Memory",
            "unit": "KB",
            "value": 176.66,
            "extra": "bytes=180897 mallocs=2339 obj=425/30600 shape=137/22008 prop=1514/27216 str=79/4180 atom=774/49515 jsfunc=99/19751 pc2line=61/567 save_weakref=5112 save_shape=1096"
          },
          {
            "name": "+ sleep — Bytecode",
            "unit": "KB",
            "value": 5.22,
            "extra": "js_func_code_size=5344 bytes, 99 functions"
          },
          {
            "name": "+ sleep — Live Allocations",
            "unit": "count",
            "value": 2339,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ sntp — Total Memory",
            "unit": "KB",
            "value": 182.35,
            "extra": "bytes=186724 mallocs=2426 obj=439/31608 shape=138/22104 prop=1542/27792 str=85/4500 atom=788/50188 jsfunc=106/21262 pc2line=66/603 save_weakref=5248 save_shape=1104"
          },
          {
            "name": "+ sntp — Bytecode",
            "unit": "KB",
            "value": 5.58,
            "extra": "js_func_code_size=5719 bytes, 106 functions"
          },
          {
            "name": "+ sntp — Live Allocations",
            "unit": "count",
            "value": 2426,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ neopixel — Total Memory",
            "unit": "KB",
            "value": 188.26,
            "extra": "bytes=192782 mallocs=2518 obj=456/32832 shape=139/22248 prop=1581/28544 str=91/4824 atom=797/50622 jsfunc=115/23123 pc2line=72/617 save_weakref=5376 save_shape=1112"
          },
          {
            "name": "+ neopixel — Bytecode",
            "unit": "KB",
            "value": 5.81,
            "extra": "js_func_code_size=5952 bytes, 115 functions"
          },
          {
            "name": "+ neopixel — Live Allocations",
            "unit": "count",
            "value": 2518,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ pwm — Total Memory",
            "unit": "KB",
            "value": 193.77,
            "extra": "bytes=198416 mallocs=2603 obj=472/33984 shape=140/22392 prop=1617/29264 str=97/5143 atom=804/50947 jsfunc=123/24739 pc2line=77/631 save_weakref=5492 save_shape=1120"
          },
          {
            "name": "+ pwm — Bytecode",
            "unit": "KB",
            "value": 6.04,
            "extra": "js_func_code_size=6180 bytes, 123 functions"
          },
          {
            "name": "+ pwm — Live Allocations",
            "unit": "count",
            "value": 2603,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ spi — Total Memory",
            "unit": "KB",
            "value": 199.21,
            "extra": "bytes=203990 mallocs=2690 obj=489/35208 shape=142/22632 prop=1655/30016 str=103/5462 atom=809/51183 jsfunc=131/26279 pc2line=82/643 save_weakref=5604 save_shape=1136"
          },
          {
            "name": "+ spi — Bytecode",
            "unit": "KB",
            "value": 6.21,
            "extra": "js_func_code_size=6359 bytes, 131 functions"
          },
          {
            "name": "+ spi — Live Allocations",
            "unit": "count",
            "value": 2690,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ i2c — Total Memory",
            "unit": "KB",
            "value": 205.01,
            "extra": "bytes=209934 mallocs=2782 obj=507/36504 shape=144/22872 prop=1696/30800 str=109/5781 atom=814/51418 jsfunc=140/28060 pc2line=88/657 save_weakref=5720 save_shape=1152"
          },
          {
            "name": "+ i2c — Bytecode",
            "unit": "KB",
            "value": 6.41,
            "extra": "js_func_code_size=6562 bytes, 140 functions"
          },
          {
            "name": "+ i2c — Live Allocations",
            "unit": "count",
            "value": 2782,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ uart — Total Memory",
            "unit": "KB",
            "value": 210.71,
            "extra": "bytes=215764 mallocs=2869 obj=524/37728 shape=146/23112 prop=1734/31552 str=115/6101 atom=818/51611 jsfunc=149/29797 pc2line=93/671 save_weakref=5828 save_shape=1168"
          },
          {
            "name": "+ uart — Bytecode",
            "unit": "KB",
            "value": 6.64,
            "extra": "js_func_code_size=6796 bytes, 149 functions"
          },
          {
            "name": "+ uart — Live Allocations",
            "unit": "count",
            "value": 2869,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ wifi — Total Memory",
            "unit": "KB",
            "value": 230.04,
            "extra": "bytes=235557 mallocs=3189 obj=574/41328 shape=150/23952 prop=1858/33776 str=138/7336 atom=875/54522 jsfunc=185/36389 pc2line=127/800 save_weakref=6348 save_shape=1200"
          },
          {
            "name": "+ wifi — Bytecode",
            "unit": "KB",
            "value": 7.74,
            "extra": "js_func_code_size=7930 bytes, 185 functions"
          },
          {
            "name": "+ wifi — Live Allocations",
            "unit": "count",
            "value": 3189,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ http/request — Total Memory",
            "unit": "KB",
            "value": 249.71,
            "extra": "bytes=255705 mallocs=3419 obj=610/43920 shape=153/24392 prop=1941/35360 str=145/7725 atom=919/56754 jsfunc=221/43881 pc2line=151/997 save_weakref=6696 save_shape=1224"
          },
          {
            "name": "+ http/request — Bytecode",
            "unit": "KB",
            "value": 10.14,
            "extra": "js_func_code_size=10380 bytes, 221 functions"
          },
          {
            "name": "+ http/request — Live Allocations",
            "unit": "count",
            "value": 3419,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/nvs — Total Memory",
            "unit": "KB",
            "value": 260.51,
            "extra": "bytes=266765 mallocs=3583 obj=639/46008 shape=156/24752 prop=2007/36592 str=152/8105 atom=940/57841 jsfunc=236/47076 pc2line=159/1070 save_weakref=6924 save_shape=1248"
          },
          {
            "name": "+ kv/nvs — Bytecode",
            "unit": "KB",
            "value": 10.95,
            "extra": "js_func_code_size=11217 bytes, 236 functions"
          },
          {
            "name": "+ kv/nvs — Live Allocations",
            "unit": "count",
            "value": 3583,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ kv/rtc — Total Memory",
            "unit": "KB",
            "value": 264.55,
            "extra": "bytes=270899 mallocs=3651 obj=655/47160 shape=156/24752 prop=2044/37328 str=158/8427 atom=943/57998 jsfunc=238/47422 pc2line=160/1073 save_weakref=7024 save_shape=1248"
          },
          {
            "name": "+ kv/rtc — Bytecode",
            "unit": "KB",
            "value": 11.03,
            "extra": "js_func_code_size=11299 bytes, 238 functions"
          },
          {
            "name": "+ kv/rtc — Live Allocations",
            "unit": "count",
            "value": 3651,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "+ test — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "+ test — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "+ test — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "steady_state (post-GC) — Total Memory",
            "unit": "KB",
            "value": 298.48,
            "extra": "bytes=305644 mallocs=4090 obj=720/51840 shape=160/25560 prop=2242/40784 str=164/8747 atom=1025/64133 jsfunc=302/60994 pc2line=211/1579 save_weakref=7636 save_shape=1280"
          },
          {
            "name": "steady_state (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.14,
            "extra": "js_func_code_size=15507 bytes, 302 functions"
          },
          {
            "name": "steady_state (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4090,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_peak — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_peak — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_peak — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "workload_settled (post-GC) — Total Memory",
            "unit": "KB",
            "value": 301.54,
            "extra": "bytes=308778 mallocs=4135 obj=730/52560 shape=161/25696 prop=2267/41264 str=169/9030 atom=1030/64383 jsfunc=305/61764 pc2line=214/1597 save_weakref=7716 save_shape=1288"
          },
          {
            "name": "workload_settled (post-GC) — Bytecode",
            "unit": "KB",
            "value": 15.29,
            "extra": "js_func_code_size=15656 bytes, 305 functions"
          },
          {
            "name": "workload_settled (post-GC) — Live Allocations",
            "unit": "count",
            "value": 4135,
            "extra": "live malloc slots; churn proxy"
          },
          {
            "name": "binary_size — libmikrojs.a",
            "unit": "KB",
            "value": 1871.01,
            "extra": "1915916 bytes (libmikrojs.a)"
          },
          {
            "name": "binary_size — libquickjs.a",
            "unit": "KB",
            "value": 1479.33,
            "extra": "1514830 bytes (libquickjs.a)"
          },
          {
            "name": "binary_size — memory_bench (stripped)",
            "unit": "KB",
            "value": 1439.44,
            "extra": "1473984 bytes (memory_bench)"
          }
        ]
      }
    ]
  }
}