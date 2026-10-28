# Native canvas 许可材料（macOS arm64）

本目录对应 `@napi-rs/canvas@1.0.13` 与 `@napi-rs/canvas-darwin-arm64@1.0.13` 的实际发布输入。wrapper 的 MIT 不覆盖整个 native 二进制的第三方许可。随 native 二进制分发时，保留本目录整体及 `desktop/THIRD-PARTY-NOTICES.md`；单独复制 wrapper `LICENSE` 或 SBOM 不包含这里收集的第三方原文。

## 输入与来源链

- 发布 SBOM 原样保存在 [sbom.cdx.json](sbom.cdx.json)，142 项为 127 个 registry crates、2 个 local crates、12 个 Skia C/C++ dependencies 与 1 个 native binary。
- binary：`skia.darwin-arm64.node`，SHA-256 `d0c066603c5dc0cd43a1a12253c79a6de8556dd724cd3436b978513aaef0904d`，`29658368` bytes。发布 npm archive 的 SHA-512 integrity 已核对；其 binary 与 SBOM 和安装输入逐字一致。
- canvas 固定源码提交为 [`00a115d9903647f116daf86eccd2c6ba36128371`](https://github.com/Brooooooklyn/canvas/tree/00a115d9903647f116daf86eccd2c6ba36128371)，来自官方 npm 固定版本元数据 `gitHead`。git tree 与 `.gitmodules` 指向 [`google/skia@b94213a11b3a2edadfae89f0c57a7f4ab72772c9`](https://github.com/google/skia/tree/b94213a11b3a2edadfae89f0c57a7f4ab72772c9)。证据原文在 `provenance/`。
- 127 个 registry crate 从 crates.io 官方精确版本 `.crate` archive 取得，全部 archive SHA-256 与发布 SBOM 相符；129 项 Cargo 名称、版本及可用 checksum 与上述 canvas 提交的 `Cargo.lock` 相符。12 个 Skia dependency 的 commit 与上述 Skia `DEPS` 相符。

[manifest.json](manifest.json) 是逐组件索引：`bomRef`、精确版本、SBOM 许可声明、archive 的实际声明、notice 路径、原 URL、SHA-256、原始路径、适用范围及剩余缺口。`files` 收录每份上游文件的原始字节摘要，`source` 给出精确源码获取地址；[manifest.schema.json](manifest.schema.json) 约束其数据结构。原始许可不翻译、不改写、不合并为无归属的通用模板。

## 如何阅读原文

| 位置 | 内容与适用范围 |
| --- | --- |
| `wrapper/LICENSE` | canvas wrapper／本地 canvas crate 的 MIT 原文；不是完整 native notices |
| `crates/<name>-<version>/` | 精确 crates.io 归档内的命名 LICENSE／COPYING／COPYRIGHT／NOTICE／PATENTS／AUTHORS，包括 crate 内 vendored 库的独立许可 |
| `crates/*/upstream/` | 该版本包缺许可文件时，按 `.cargo_vcs_info.json` 固定提交取得的仓库根许可；未使用浮动分支或最新版 |
| `crates/*/source-notices/` | MPL crate 的原始源码文件，用于保留文件级 MPL 声明，作为许可证据，不属于 YiZhi 产品源码 |
| `skia/` | 固定 Skia 提交自身及仓库内 skcms、third_party 等目录的命名许可文件；也保守保留构建／CanvasKit 目录 notice |
| `skia-deps/<name>/` | SBOM 12 个固定 commit 的完整官方源码归档内命名许可文件；另保留 FreeType／IJG／SIMD 等嵌入式声明所在原文件 |
| `provenance/` | npm 固定版本元数据、canvas git tree、Cargo.lock／toml、SBOM 生成器、GN args、Skia DEPS 与 Fontations BSD 声明 |

127 个 crate 中，`base64-simd`、`vsimd`、`napi`、`napi-build`、`napi-derive`、`napi-derive-backend`、`napi-sys` 与 `selectors` 的精确发布包没有独立许可文件，采用上面说明的提交来源。前两者的根 MIT 提交为 `d74c030d9dc4f3cae02146d1f497ff62726ef09a`，NAPI 系列为 `956e4525fea6a676ea3680b711382f167b899af9`。`selectors` 的处理见下一节。

`anstyle`、`clap`、`clap_builder`、`clap_lex`、`cxxbridge-cmd`、`strsim` 的 SBOM 缺许可声明；manifest 保留原 SBOM 状态，并另记精确 archive 的 `Cargo.toml` 声明及原文，没有把缺值猜成 MIT。`libaom-sys` 的 archive VCS metadata 标为 dirty；精确源码以 checksum 已核对的 `.crate` 为准，不用其 Git commit 替代 archive。

local `canvas@0.1.0` 是 canvas 仓库自身，不能下载同名 registry 包代替。local `skia-fontations@0.0.0` 的 `lib.path` 指向 Skia `src/ports/fontations/src/ffi.rs`，文件标明 Copyright 2023 Google LLC 与 BSD，适用 [Skia LICENSE](skia/LICENSE)，不归为 wrapper MIT。

## MPL-2.0 原文与源码获取

以下 MPL 组件的精确 Source Code Form 可以从官方版本 archive 获取。YiZhi 本次只整理发布二进制的许可材料，没有修改这些上游源码；这里不主张已重建或证明上游 binary 与公开源码逐对象一致。

| 组件 | 官方精确源码 archive | 本地声明／原文 |
| --- | --- | --- |
| cssparser 0.38.0 | [cssparser-0.38.0.crate](https://static.crates.io/crates/cssparser/cssparser-0.38.0.crate) | [MPL-2.0](crates/cssparser-0.38.0/LICENSE)、`source-notices/src/lib.rs` |
| cssparser-macros 0.7.0 | [cssparser-macros-0.7.0.crate](https://static.crates.io/crates/cssparser-macros/cssparser-macros-0.7.0.crate) | [MPL-2.0](crates/cssparser-macros-0.7.0/LICENSE)、`source-notices/lib.rs` |
| dtoa-short 0.3.5 | [dtoa-short-0.3.5.crate](https://static.crates.io/crates/dtoa-short/dtoa-short-0.3.5.crate) | [MPL-2.0](crates/dtoa-short-0.3.5/LICENSE)、`source-notices/src/lib.rs` |
| selectors 0.41.0 | [selectors-0.41.0.crate](https://static.crates.io/crates/selectors/selectors-0.41.0.crate) | `source-notices/lib.rs` 文件级 MPL 声明；完整 MPL-2.0 文本复用精确 cssparser 0.38.0 归档所附 [LICENSE](crates/cssparser-0.38.0/LICENSE) |

`selectors` 对应固定源码提交为 [`34d25f741765a0bdb894f8271852e633299352d8`](https://github.com/servo/stylo/tree/34d25f741765a0bdb894f8271852e633299352d8/selectors)。该归档／提交未附完整 MPL 文件；不把同一仓库其他子包的 MIT／Apache 文件当作 selectors 的许可。

## 组合许可和 attribution

FreeType 按 FTL 路径记录；[LICENSE.TXT](skia-deps/freetype/LICENSE.TXT) 同时说明了 GPL 备选与部分文件的独立许可。为保留上游原貌，这里也保留 GPL 备选原文；这不表示选择 GPL 路径。FTL、BDF／PCF 的 MIT 风格条款、hash 文件条款、gzip 的 zlib 原文与 HarfBuzz 嵌入声明一并保留。版本版权年份取自该 commit 的 `include/freetype/freetype.h`：

> Portions of this software are copyright © 2026 The FreeType Project (www.freetype.org). All rights reserved.

libjpeg-turbo 同时涉及 BSD-3-Clause、IJG 与 zlib；保留 [LICENSE.md](skia-deps/libjpeg-turbo/LICENSE.md)、[README.ijg](skia-deps/libjpeg-turbo/README.ijg) 与 `simd/nasm/jsimdext.inc` 原始声明。按其分发说明：

> This software is based in part on the work of the Independent JPEG Group.

ICU 的 SBOM 标签 `ICU` 不是该 commit 的完整描述：[LICENSE](skia-deps/icu/LICENSE) 实际包含 Unicode License V3、历史 ICU、字典数据、double-conversion 等第三方条款和构建工具说明。完整保留 LICENSE 与其他命名 notices，不把它们压成单一 MIT 或 ICU 模板。`unicode-ident` 的 `(MIT OR Apache-2.0) AND Unicode-3.0` 也保留独立 Unicode 原文。

## 范围与尚未证明的部分

这是一份对精确发布输入的 **SBOM 清单许可材料对应表**，不是二进制对象级许可闭包或可重现构建证明。上游生成器从整个 Cargo.lock 罗列 crates，并按 GN args 选择 Skia 依赖；SBOM 只把全部组件挂在 npm 根，没有实际 feature／target 链接图或 link map。

manifest 明确标出根 `Cargo.toml` 的 `cc`、`cxx-build`、`napi-build` 为直接 build-dependencies，并标出 macOS target dependencies；其余未证明的 scope 不猜测。proc-macro、其他平台组件及上游工具／测试／示例 notices 保守保留；保留某份原文不代表该工具或其许可实际适用于 runtime。

已收集精确 archive 中按名称识别的全部许可／版权／NOTICE／PATENTS／AUTHORS 文件，并补关键内嵌声明。未逐源文件审计所有内嵌 copyright／SPDX，也未恢复实际编译文件集；这些缺口在 manifest `coverage.remainingGaps` 中明确保留。发布材料需要包含本目录；将它复制进最终安装包及验证安装包内容属于 packager 的工作，本目录不证明该步骤已完成。

## Skia dependency 精确源码

| 组件 | 固定 commit 与源码获取 |
| --- | --- |
| expat | [`6154446fccefbf3ca644894f598969113b0c7bcd`](https://chromium.googlesource.com/external/github.com/libexpat/libexpat.git/+/6154446fccefbf3ca644894f598969113b0c7bcd) · [官方完整源码 archive](https://chromium.googlesource.com/external/github.com/libexpat/libexpat.git/+archive/6154446fccefbf3ca644894f598969113b0c7bcd.tar.gz) |
| freetype | [`264b5fbf5b912b39f98d038bf75d39be0a73f21b`](https://chromium.googlesource.com/chromium/src/third_party/freetype2.git/+/264b5fbf5b912b39f98d038bf75d39be0a73f21b) · [官方完整源码 archive](https://chromium.googlesource.com/chromium/src/third_party/freetype2.git/+archive/264b5fbf5b912b39f98d038bf75d39be0a73f21b.tar.gz) |
| brotli | [`6d03dfbedda1615c4cba1211f8d81735575209c8`](https://skia.googlesource.com/external/github.com/google/brotli.git/+/6d03dfbedda1615c4cba1211f8d81735575209c8) · [官方完整源码 archive](https://skia.googlesource.com/external/github.com/google/brotli.git/+archive/6d03dfbedda1615c4cba1211f8d81735575209c8.tar.gz) |
| harfbuzz | [`9cb1fee51069b206effb4736e443b038d230789d`](https://chromium.googlesource.com/external/github.com/harfbuzz/harfbuzz.git/+/9cb1fee51069b206effb4736e443b038d230789d) · [官方完整源码 archive](https://chromium.googlesource.com/external/github.com/harfbuzz/harfbuzz.git/+archive/9cb1fee51069b206effb4736e443b038d230789d.tar.gz) |
| icu | [`d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738`](https://chromium.googlesource.com/chromium/deps/icu.git/+/d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738) · [官方完整源码 archive](https://chromium.googlesource.com/chromium/deps/icu.git/+archive/d578f2e8b7bd5938e21cfb6bf15c079e0aa5b738.tar.gz) |
| libjxl | [`332feb17d17311c748445f7ee75c4fb55cc38530`](https://chromium.googlesource.com/external/gitlab.com/wg1/jpeg-xl.git/+/332feb17d17311c748445f7ee75c4fb55cc38530) · [官方完整源码 archive](https://chromium.googlesource.com/external/gitlab.com/wg1/jpeg-xl.git/+archive/332feb17d17311c748445f7ee75c4fb55cc38530.tar.gz) |
| highway | [`457c891775a7397bdb0376bb1031e6e027af1c48`](https://chromium.googlesource.com/external/github.com/google/highway.git/+/457c891775a7397bdb0376bb1031e6e027af1c48) · [官方完整源码 archive](https://chromium.googlesource.com/external/github.com/google/highway.git/+archive/457c891775a7397bdb0376bb1031e6e027af1c48.tar.gz) |
| libjpeg-turbo | [`e14cbfaa85529d47f9f55b0f104a579c1061f9ad`](https://chromium.googlesource.com/chromium/deps/libjpeg_turbo.git/+/e14cbfaa85529d47f9f55b0f104a579c1061f9ad) · [官方完整源码 archive](https://chromium.googlesource.com/chromium/deps/libjpeg_turbo.git/+archive/e14cbfaa85529d47f9f55b0f104a579c1061f9ad.tar.gz) |
| libpng | [`d5515b5b8be3901aac04e5bd8bd5c89f287bcd33`](https://skia.googlesource.com/third_party/libpng.git/+/d5515b5b8be3901aac04e5bd8bd5c89f287bcd33) · [官方完整源码 archive](https://skia.googlesource.com/third_party/libpng.git/+archive/d5515b5b8be3901aac04e5bd8bd5c89f287bcd33.tar.gz) |
| libwebp | [`845d5476a866141ba35ac133f856fa62f0b7445f`](https://chromium.googlesource.com/webm/libwebp.git/+/845d5476a866141ba35ac133f856fa62f0b7445f) · [官方完整源码 archive](https://chromium.googlesource.com/webm/libwebp.git/+archive/845d5476a866141ba35ac133f856fa62f0b7445f.tar.gz) |
| wuffs | [`e3f919ccfe3ef542cfc983a82146070258fb57f8`](https://skia.googlesource.com/external/github.com/google/wuffs-mirror-release-c.git/+/e3f919ccfe3ef542cfc983a82146070258fb57f8) · [官方完整源码 archive](https://skia.googlesource.com/external/github.com/google/wuffs-mirror-release-c.git/+archive/e3f919ccfe3ef542cfc983a82146070258fb57f8.tar.gz) |
| zlib | [`646b7f569718921d7d4b5b8e22572ff6c76f2596`](https://chromium.googlesource.com/chromium/src/third_party/zlib/+/646b7f569718921d7d4b5b8e22572ff6c76f2596) · [官方完整源码 archive](https://chromium.googlesource.com/chromium/src/third_party/zlib/+archive/646b7f569718921d7d4b5b8e22572ff6c76f2596.tar.gz) |


## 离线完整性核验

`SHA256SUMS` 覆盖本目录除清单自身外的全部文件，包含上游原文、manifest、schema 和本说明；它用于检查分发复制是否完整，不证明法律充分性。可以从仓库根运行：

```sh
cd desktop/licenses/native-canvas
shasum -a 256 -c SHA256SUMS
```

manifest 的 schema 校验还需检查组件与 SBOM 的 `bom-ref` 集合一致、全部 `noticeFiles`／共享 MPL 文本／scope evidence 路径存在，并检查来源 archive 与 SBOM checksum 的对应关系；schema 仅约束 JSON 结构。
