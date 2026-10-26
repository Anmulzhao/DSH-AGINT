# Changelog

## 0.1.6 鈥?2026-10-14

### 鏂板锛氶€氶亾闆跺懡涓憡璀︼紙`lib/zero-hit.js`锛?
**鍔ㄦ満**锛氫袱娆℃挒鍒板悓涓€绫荤梾 鈥斺€?銆屾病鎵埌涓滆タ銆嶄笌銆屾壂鍒颁簡浣嗘病杩囧叧銆嶅湪杩斿洖閲岄暱寰?涓€妯′竴鏍凤紝鏄潤榛樺け鏁堟渶鑸掓湇鐨勬俯搴娿€?
1. self-observation 鐨?streak 鍒ゆ嵁淇鍓嶇畻鍑?0銆佷慨澶嶅悗妫€鍑?`pwsh` 杩炵画 5 娆″け璐ワ紝
   鑰屼慨澶嶅墠 `health()` 鎶?5 涓娴嬪櫒鍏?`active=true`銆乣force_fetch` 鎶?   `ok=true in=0 emitted=0` 鈥斺€?鐪嬭捣鏉ュ仴搴凤紝瀹炲垯浜т笉鍑轰俊鍙枫€?2. dream 渚?2026-09-10 鍥犲涓绘敼鏃ュ織鍛藉悕杩炵画 7 澶╂壂鍒?0 涓細璇濓紝`dream_status`
   浠嶆姤 `validation=OK`锛坉ream 宸插湪 `lib/health.js` 琛ヤ簡鍛婅锛屾湰鎻掍欢姝ゅ墠娌℃湁锛夈€?
**鍒ゆ嵁**锛氳繛缁?N 娆?fetch 浜у嚭 0 鏉′俊鍙?鈬?`status=degraded`銆?鍙栫殑鏄€屾湁娌℃湁鐪熺殑浜у嚭淇″彿銆嶏紝涓嶆槸銆屾湁娌℃湁璺戙€嶁€斺€?鍚庤€呮案杩?ok銆?
**璁捐鍙栬垗**锛堜笌 `agint-dream/lib/health.js` 鍚屽瀷锛岀収鍏堜緥鍋氫笉鑷垱锛夛細
- 绾鍒欙紝鏈哄櫒鍙垽鍙洖鏀撅紝涓嶅紩鍏?LLM锛?- **涓嶉樆鏂?fetch** 鈥斺€?瑙傚療灞傦紝鍙爣璁?+ 钀界洏 + warn銆?  鉀?鍛婅鏉€姝昏鍛婅瀵硅薄鏄繖绫讳唬鐮佺殑缁忓吀鑷激锛堟湁娴嬭瘯瀹堬級锛?- kill-switch锛坄zeroHitAlert=false`锛? 鍙皟闃堝€硷紙`zeroHitAlertThreshold`锛夛紱
- 鐘舵€佽惤鍦?`channel_state` 琛?鈥斺€?鍐呭瓨璁℃暟浼氬湪閲嶅惎鏃跺綊闆讹紝閭ｇ瓑浜庢憜璁撅紱
- 璇诲啓澶辫触 fail-open锛屽憡璀﹂摼涓嶅緱鎶?fetch 鎼炴寕銆?
**鍙娴嬫€?*锛歚getChannelStatus()` 鎸?`zeroHit` 瀛楁锛宍input_gateway_status` 涓?`input_gateway_channel_status` 涓や釜 render 閮芥覆鏌撳畠 鈥斺€?涓嶆覆鏌撳氨鏄?銆岀畻鍑烘潵浜嗕絾鐪嬩笉瑙併€嶇殑鍋囩豢锛圥laybook 搂3.19锛夈€?
**瀛樺偍鍏煎**锛歚ChannelStateSchema` 鏂板 4 涓瓧娈靛叏閮?`.nullish()`銆?鉀?蹇呭～浼氳 dsh-storage-domain 鐨?open 鏍￠獙澶辫触 鈬?鏁村煙鎷掔粷 鈬?gateway 绌鸿浆
锛?026-10-03 鐜板満鍙栬瘉锛屽悓鍧戣俯杩囦袱娆★紝瑙?CountersSchema 鐨?security* 娉ㄩ噴锛夈€?
### 楠岃瘉

- 鏂板 `test/zero-hit.test.mjs`锛? 椤癸級锛氱湡璋?`InputGateway.fetchChannel()` 绔埌绔€?  瑕嗙洊闃堝€艰Е鍙?/ 璁℃暟褰掗浂 / kill-switch / 闃堝€煎彲璋?/ 涓嶉樆鏂?fetch /
  钀?channel_state / 瀛橀噺璁板綍缂哄瓧娈?fail-open / 鍏ㄦ垚鍔熶笉鍛婅銆?- 绾㈢豢鑷瘉锛氭挙鎺夋帴绾?鈬?鍏ㄧ孩锛涙仮澶?鈬?9/9 缁裤€?- 鍏ㄦ彃浠跺洖褰?60/60 PASS锛宍test/smoke.mjs` exit 0銆?

## 0.1.5 — 2026-10-14（本机并行开发段；与下方 0.1.5—2026-10-09 为两台机器各自独立发布，重名非笔误）

### 淇锛歞etectToolAnomaly 鐨勩€岃繛缁け璐ャ€嶅垽鎹粠鏈敓鏁?
**鏍瑰洜**锛坄lib/channels/self-observation.js` 淇鍓嶏級锛氫粠鍚庡線鍓嶆壂绐楀彛鏃跺啓浜?`else { break; }` 鈥斺€?閭ｆ祴鐨勬槸銆?*鏂囦欢鏈熬**鐨勫け璐ユ父绋嬨€嶏紝涓嶆槸銆岀獥鍙ｅ唴鍚屼竴 tool
鐨?*鏈€闀?*澶辫触娓哥▼銆嶃€傜湡瀹炴暟鎹湯灏鹃偅鏉″嚑涔庢€绘槸鎴愬姛鐨?鈬?`maxStreakCount` 鎭掍负 0
鈬?璇ュ垽鎹嚜钀藉湴璧蜂粠鏈骇鍑鸿繃淇″彿銆?
**瀹炴祴**锛堢敓浜?`agint_tool_stats.jsonl`锛?6822 琛岋紝2026-10-14锛夛細

| 椤?| 淇鍓?| 淇鍚?|
|---|---|---|
| 鏈€闀胯繛缁け璐?| 0锛堟湯灏炬垚鍔熷嵆 break锛?| `pwsh` 杩炵画 5 娆★紙闃堝€?鈮?锛?|
| 鏄惁瑙﹀彂 | 鍚?| 鏄?|

**鐥囩姸褰㈢姸**锛歚channel.health()` 鏄剧ず 5 涓娴嬪櫒鍏?`active=true`锛?`fetch()` 杩斿洖 `[]`锛宍force_fetch` 鎶?`ok=true in=0 emitted=0`
鈥斺€?鐪嬭捣鏉ュ仴搴凤紝瀹炲垯闈欓粯澶辨槑銆備笌 搂3.29銆岄潤榛橀浂銆嶅悓涓€绫汇€?
**淇硶**锛氶€愭潯缁存姢褰撳墠娓哥▼锛堥亣鎴愬姛褰掗浂锛夛紝鍙栫獥鍙ｅ唴鍘嗗彶鏈€澶у€笺€?鍚?tool 鐩搁偦澶辫触鎵嶇畻杩炵画锛屼腑闂村す涓€娆℃垚鍔熷嵆鏂摼銆?
### 楠岃瘉

- 鏂板 `test/tool-anomaly-streak.test.mjs`锛? 椤癸級锛屽叏璧?`channel.fetch()` 绔埌绔細
  涓棿娈佃繛缁け璐ュ繀妫€鍑?/ 鍏ㄦ垚鍔熶笉浜т俊鍙?/ 瀛ょ珛澶辫触涓嶈Е鍙?/ 鏍锋湰涓嶈冻鏁存潯璺宠繃銆?- 绾㈢豢鑷瘉锛氫慨澶嶅墠鏍稿績鐢ㄤ緥绾紙瀹炲緱 0 鏉′俊鍙凤級锛屼慨澶嶅悗 5/5 缁裤€?- 鍏ㄦ彃浠跺洖褰?51/51 PASS锛宍test/smoke.mjs` exit 0銆?
### 娴嬭瘯鍩哄缓

- 鏂板 `test/_stub-loader.mjs` + `test/_stub-register.mjs`锛氭湰鏈轰粨搴撳伐浣滄爲缂?  `@deepseek-ai/dsh-storage-domain` 涓?`@deepseek-ai/dsh-tools`锛堝彧鍦?dsh 杩愯鏃?  鎻愪緵锛夈€傝８璺?`node --test` 鎶?ERR_MODULE_NOT_FOUND銆傝窇娴嬭瘯闇€
  `node --import ./test/_stub-register.mjs --test test/xxx.test.mjs`銆?

## 0.1.5 — 2026-10-09（远端并行开发段）

淇?C4 adversarial 鐨勪簨浠惰闃?*浠庢湭鐢熸晥**锛屼笖 `health()` 鎶ュ亣缁裤€?
### 闂

`lib/channels/adversarial.js` 鐨勮闃呮敞鍐岋細

```js
ctx.effect(() => { try { disposer(); } catch {} });   // 鉂?灏戜竴灞傜澶?```

`ctx.effect(fn)` 浼?*绔嬪嵆鎵ц** `fn`锛屼笖鍙湁 `fn` **杩斿洖鍑芥暟**鏃惰鍑芥暟鎵嶈鏀堕泦
涓?disposer锛坈ordis `src/fiber.ts:363-372`锛歚execute` 绔嬪嵆璋冪敤锛?`typeof effect === 'function'` 鎵?`collect`锛夈€傚師鍐欐硶鐨勫嚱鏁颁綋鐩存帴璋冪敤
`disposer()` 骞惰繑鍥?`undefined`锛屼簬鏄細

1. 璁㈤槄鍦?`initSubscriptions` 鎵ц鐨勯偅涓€鍒诲氨琚嚜宸辨挙鎺夛紱
2. 娌℃湁浠讳綍 disposer 琚敹闆嗭紝鍗歌浇璺緞涔熸棤浠庢竻鐞嗐€?
**杩愯鏃舵梺璇?*锛歚eventBus_deliveryByTopic` 鐨?`orphanSubscriptions` 閲屾湁 4 涓?`diagnosis.completed` 璁㈤槄鑰咃紙`agint-mutator` / `agint-ov-strategy` /
`agint-self-model` / `agint-trajectory`锛夛紝鍞嫭娌℃湁
`agint-input-gateway/adversarial`銆俠us 鐨勫鍎垮垽鎹槸銆岃闃呯殑鎵€鏈変富棰橀兘鏃犳姇閫掋€嶏紝
鑰屽畠閭ｄ笁涓富棰樹粠鏈?publish 鈥斺€?瀹冩湰璇ュ湪鍒楄〃閲岋紝涓嶅湪鍗宠鏄庢病杩涜闃呰〃銆?
**鍋囩豢**锛歚_subscribed = true` 鍦ㄩ€€璁箣鍓嶇疆浣嶏紙`adversarial.js:178`锛夛紝涔嬪悗鍐嶆棤浜?鏀瑰洖銆俙health()` 鍥犳鎶?`status:ok` / `initError:null` / `detectors` 涓夐」鍏?`active:true`锛岃€屽疄闄呭姛鑳芥暣涓瀻銆傜敓浜ф暟鎹綈璇侊細`ingestedSignals` 涓?0銆?
**娴嬭瘯涓轰綍娌℃姄鍒?*锛歚test/adversarial.test.mjs` 鐨?fake ctx 鏈変袱澶勫け鏄?鈥斺€?`subscribe` 杩斿洖 `() => {}`锛堢┖ disposer锛夈€乣effect: () => {}`锛堜笉鎵ц浼犲叆鐨?鍑芥暟锛夈€傚叏鏂囦欢 108 琛屾祴璇曞叏缁匡紝鑰岃闃呭湪鐢熶骇涓婁粠鏈敓鏁堛€?
### 鏀瑰姩

- `lib/channels/adversarial.js`锛氭敼涓?`ctx.effect(() => () => { try { disposer(); } catch {} })`锛?  涓庡悓鎻掍欢 `lib/index.js` 鐨勫啓娉曚竴鑷淬€?- `test/adversarial.test.mjs`锛歠ake ctx 鎸?`fiber.ts:363-372` 澶嶅埢 `effect` 璇箟锛?  `subscribe` 杩斿洖鐪熼€€璁?disposer锛涙柊澧?2 鏉″洖褰掓柇瑷€锛堣闃呭湪鍒濆鍖栧悗浠嶅瓨娲?/
  鍗歌浇璺緞鑳介€€璁級銆?
### 楠岃瘉

- 鍏ㄩ噺 58 椤?fail 0锛沗adversarial.test.mjs` 10/10銆?- **娉ㄥ叆 bug 鍚?8/10 鍙樼孩**锛堝惈鏍稿績鍥炲綊閭ｆ潯锛夆€斺€?璇佹槑娴嬭瘯涓嶆槸鑷瘉閫氳繃銆?- lint 涓庡熀绾夸竴鑷达紙K19脳1 / manifest脳4 / package.json脳1锛夛紝鏃犳柊澧?FAIL銆?- `check-wiring` PASS锛?8/58 鍙屽壇鏈竴鑷淬€?48 涓?lib 鏂囦欢鍚屾銆?- BOM锛坄efbbbf`锛変笌鏂囦欢灏炬崲琛屽潎鏈缂栬緫宸ュ叿鏀瑰姩 鈥斺€?璇ユ枃浠跺甫 BOM锛?  缂栬緫鍚庨€愬瓧鑺傛牳瀵瑰苟杩樺師锛坉iff 12 insert / 1 delete锛夈€?
### 浠嶆湭瑙ｅ喅

璁㈤槄淇ソ鍚庯紝`diagnosis.completed` / `curriculum.challenge-verdicted` /
`curriculum.boundary-probed` 涓変釜涓婚鍦?eventBus 涓婁粛鏃?publisher锛堝叏閲?eventBus
鍙湁 `ov.session.flushed` / `memory.provider-activated` / `ov.recall.checked` 涓変釜
topic锛夈€傚嵆銆岃闃呴€氫簡锛屼絾涓婃父娌′汉鍙戙€嶁€斺€斿睘 event bus 杞璁锛屽崟鐙帓鏈熴€?
## 0.1.4 鈥?2026-10-06

鏈壒鍋氫袱浠惰€佹澘鎷嶆澘鐨勪簨锛欻1锛坅dversarial 璺ㄩ噸鍚涪淇″彿锛夋柟妗堚憽銆丆5 鏂规 B锛坰ync-proposal 鎻愭淇″彿锛夈€傚彟淇袱澶勫彛寰勪笉涓€鑷淬€?
### H1 鏂规鈶★細浜嬩欢鍒拌揪鍗虫姇锛屽垹鍐呭瓨闃熷垪

**鏍瑰洜**锛歛dversarial 鎶婅闃呭埌鐨勪簨浠舵斁杩涙ā鍧楃骇鍐呭瓨 `_queue`锛岄潬 `fetch()` 瀹氭湡 drain銆?閲嶅惎娓呯┖闃熷垪 鈬?drain 鍛ㄦ湡锛堝懆/鏃ワ級涓庨噸鍚箣闂寸殑绐楀彛锛屼簨浠舵案涓嶅彲瑙併€?鐢熶骇瀹炶瘉锛歚diagnosis.completed` 鍏ㄥ巻鍙?37 鏉°€乣curriculum.boundary-probed` 5 鏉★紝
閫氶亾 drain 璺?7 娆?`signalsEmitted=0`锛坄~/.dsh/storages/agint_input_gateway.json`锛夛紝
2 涓富棰樼殑淇″彿鍥犻噸鍚涪浜嗭紙寰呭仛娓呭崟 H1锛夈€?
**鏀规硶**锛堣€佹澘 2026-10-06 鎷嶆澘銆屾寜椤哄簭鐩存帴鎵ц銆嶏紝閫夐」鈶′紭浜庘憼锛氫笂娓镐綆棰戯紝鏀掓壒鏃犳敹鐩婏級锛?
- `lib/channels/adversarial.js`锛氬垹 `_queue`锛涜闃呭洖璋冩敼涓哄湪浜嬩欢鍒拌揪鏃剁洿鎺ヨ皟
  `gateway.ingestImmediate(CHANNEL_ID, [sig])`銆傜鍚嶆柊澧炵涓夊弬 `gateway`锛岀己瀹冨嵆
  `degraded` 涓斾笉鍚炰簨浠讹紙fail-visible锛屼笉闈欓粯锛夈€?- `lib/gateway.js`锛氭柊澧?`ingestImmediate(channelId, signals)` 鈥斺€?澶嶇敤 `processSignals`
  鍏ㄧ绾匡紙security 鈫?缃俊 鈫?鍘婚噸 鈫?鍣０ 鈫?閰嶉 鈫?鍙戝竷锛夛紝璁℃暟鍗虫椂鎸佷箙鍖栥€?  涓嶅崰 `fetchCount`锛堝嵆鎶曚笉鏄?fetch锛夈€?- `lib/index.js:122`锛歚initSubscriptions(ctx, cfg)` 鈫?`initSubscriptions(ctx, cfg, gateway)`銆?- `fetch()` 淇濈暀涓虹┖ drain 鈬?閫氶亾鍦?`channel_status` / `getStatus()` 浠嶆湁蹇冭烦锛岃娴嬮潰涓嶅彉銆?- 涓㈠け绐楀彛浠庛€宒rain 鍛ㄦ湡 脳 閲嶅惎棰戠巼銆嶇缉鍒版绉掔骇锛涢噸鍚悗鐨勪簨浠堕噸鏀剧敱 dedup 琛ㄦ嫤锛堟柊澧炵敤渚嬮攣浣忥級銆?
### C5 鏂规 B锛氭柊澧?`cross-agent.sync-proposal` 鎻愭淇″彿

`cross-agent.js` 澧炵 4 涓瓙婧愶細鎶?OV 妫€绱㈠埌鐨勫閮?preset 鏉＄洰鍙戞垚鎻愭淇″彿
锛坄items[]` = entryId/title/source锛夈€?*閫氶亾浠嶄笉鍐?OV銆佷笉鍐?preset** 鈥斺€?閲囩撼鍔ㄤ綔鐣欑粰
agent/鑰佹澘锛堣嚜鍔ㄥ弻鍚戝悓姝ヤ笌 P8 鏍″噯銆屽洟闃熻兘鍔涚敤 dsh 瀹樻柟鐨勩€嶅啿绐侊紝鏈疆鏈仛锛岃
`docs/agint-input-gateway-鏈珶鏂规璁鸿瘉-20261006.md` 搂2锛夈€?鏂板鐘舵€佷綅 `state.proposedEntryIds`锛堟粴鍔?100 鏉★級淇濊瘉鍚屼竴鏉＄洰鍙彁妗堜竴娆°€?`KNOWN_TOPICS` 琛?`input.signal.cross-agent.sync-proposal`銆?
### 椤哄甫淇殑涓ゅ鍙ｅ緞涓嶄竴鑷?
1. **adversarial cron 鍙屽彛寰?*锛氶€氶亾澹版槑 `0 3 * * 0`锛堝懆鏃ワ級锛岃皟搴﹀櫒瀹炶窇 `C4_CRON`锛堟瘡鏃?03:30锛夈€?   `_tick()` 鐢?*閫氶亾瀛楁**绠椾笅涓€娆℃椂闂?鈬?棣栬疆 fetch 涔嬪悗鑺傚浼氭紓鎴愬懆棰戙€傜幇缁熶竴鍙?`C4_CRON`銆?   涓?playbook 搂3.13銆岀浜屽鏃堕棿鍙ｅ緞銆嶅悓鏃忋€?2. **cross-agent 涓婚鍚嶄笌鏋氫妇涓嶇**锛歚_buildTopic` = `input.signal.<channelType>.<signalType>`锛?   鏃?`signalType='cross.agent.diff'` 瀹炲彂鎴?`...cross-agent.cross-agent-diff`锛?   涓?`KNOWN_TOPICS`锛堣闃呴潰/闈㈡澘鐨勫弬鐓э級涓嶇 鈥斺€?鐢熶骇宸插疄璇?1 鏉?   `input.signal.cross-agent.cross-agent-pattern`銆傛敼鍙戝竷渚у榻愭灇涓撅細signalType 鍘诲墠缂€
   锛坄diff` / `pattern` / `sync-proposal`锛夈€傛棤璁㈤槄鏂瑰彈褰卞搷锛堝叏鍘嗗彶浠?1 鏉★紝涓旀棤浜鸿 cross-agent锛夈€?
### 鍣０鎶戝埗闅愭€у皝姝伙紙鍚屾壒淇級

`processSignals` 绗?5 姝ヨ鏁颁粠涓嶆寜鏃堕棿澶嶄綅 鈬?鍚屼竴 `source:signalType` 鍦ㄤ竴涓?boot 鍐呯疮璁?鍒?5 鏉″悗**姘镐箙**琚繃婊わ紝涓庢敞閲婂绉扮殑銆?h 婊氬姩绐楀彛銆嶄笉绗︺€傛敼涓?`{count, windowStart}`
婊氬姩绐楀彛銆傚奖鍝嶉潰锛氬嵆鎶曟ā寮忎笅鏇村叧閿紙浜嬩欢涓嶅啀鏀掓壒锛岄暱鏈熻繍琛岀殑 boot 浼氬厛鎾炶繖涓笂闄愶級銆?鏂板鐢ㄤ緥锛氱獥鍙ｆ粴鍔ㄥ悗鍚岄敭蹇呴』閲嶆柊鏀捐銆?
### 娴嬭瘯

- 鏂板 `test/adversarial.test.mjs` 8 鐢ㄤ緥锛堝嵆鎶曞洓绫讳簨浠?杩囨护鏉′欢/dedup 閲嶆斁/counters 鍗虫椂钀界洏/cron 鍙ｅ緞/fetch 蹇冭烦锛夈€?- 鏂板 `test/cross-agent.test.mjs` sync-proposal 鐢ㄤ緥锛涘師 4 鐢ㄤ緥鏂█闅?signalType 鏀瑰悕鏇存柊銆?- `test/gateway.test.mjs` 鍔犲櫔澹扮獥鍙ｅ浣嶇敤渚嬨€?- 鍏ㄩ噺 `node --test "test/*.test.mjs" test/smoke.mjs` 鈫?56/56 閫氳繃锛堟敼鍓嶅熀绾?46锛屽疄娴嬩簬 stash 鍥為€€鎬侊紱鏈壒 +10锛歛dversarial 8銆乻ync-proposal 1銆佸櫔澹扮獥鍙ｅ浣?1锛涘彟鏈?4 鏉?cross-agent 鏂█闅?signalType 鏀瑰悕鏇存柊锛夈€?
## 0.1.3 鈥?2026-10-05


### manifest 鍒?`agint.memory` 鎮┖澹版槑锛堢函濂戠害锛屾棤浠ｇ爜鏀瑰姩锛?
**渚濇嵁锛堣繖娆℃槸鐧界焊榛戝瓧鐨勫弽璇侊紝涓嶆槸銆屾壘涓嶅埌鐢ㄦ硶銆嶏級**锛氭湰鎻掍欢鐨勫垎宸ヤ粠鏉ユ槸銆屽彧鍙戜簨浠躲€佷笉鑷繁娑堣垂銆嶁€斺€?
- `lib/gateway.js:8`锛氥€屼笉鑷繁娑堣垂淇″彿锛坢emory/evolve/dream 閫氳繃 eventBus subscribe 娑堣垂锛夈€嶏紱
- `README.md:12` 绠￠亾鍥撅細`Channels 鈫?Gateway 鈫?eventBus 鈫?memory/...`锛?- `CHANGELOG.md:98`锛?.1.0 P0 杈圭晫锛夛細銆屼笉淇敼 memory/evolve/dream 鐨勬秷璐圭璁㈤槄銆嶏紱
- 瀵圭**鏃╁凡瀹炶**锛歚plugins/agint-memory/lib/index.js:206-228` 璁㈤槄 8 涓?`input.signal.*` 涓婚鑷姩娌夋穩璁板繂锛?- 鏈彃浠跺敮涓€鐨勫彇鏈嶅姟鐐规槸 `lib/index.js:67` 鐨?`ctx.get('agint.eventBus.publish')`锛宍_publish` 涔熷彧鏈夋€荤嚎涓€涓嚭鍙ｃ€?
鎵€浠?optionalInject 閲岄偅琛?`agint.memory` 鑻ョ湡鍘昏ˉ鎺ョ嚎锛屾晥鏋滄槸鍚屼竴鏉′俊鍙峰啓涓や唤璁板繂锛岀洿鎺ヨ繚鑳屼笂闈㈢殑鍒嗗伐銆?鍒ゆ嵁鍑哄锛氬鏃忛潰鏉?0.2.4 璧锋妸銆屽０鏄庝簡鍗翠粠涓嶅彇鐢ㄣ€嶇殑閿垪涓烘偓绌哄０鏄庯紙瑙?`plugins/agint-family-panel/CHANGELOG.md`锛夈€?
## 0.1.2 鈥?2026-10-03

> 鐢熶骇鏁呴殰淇锛欳ountersSchema 鐨?security* 涓夊瓧娈垫鍓嶄负 `.optional()`锛屽彧璁?undefined 涓嶈 null锛?> 鐢熶骇 adversarial 璁板綍鐨?security* 瀛楁鍊间负 null锛堥潪瀛楁缂哄け锛夛紝瀵艰嚧鏁村煙 open 澶辫触銆乬ateway 绌鸿浆銆?
### 淇

- **CountersSchema security* 鏀?`.nullish()`**锛坄lib/storage.js`锛夆€斺€旂敓浜?`counters.adversarial` 鐨?  `securityScanned/securityFlagged/securityDropped` 鏇惧啓鎴?`null`锛坰ecurity 闂ㄧ钀藉湴鏈熼棿鍐欏叆锛夛紝
  `.optional()` 鏍￠獙鎷掔粷 null 鈫?`dsh-storage-domain` open 鏁翠綋澶辫触 鈫?input-gateway 鏈垵濮嬪寲
  锛? 閫氶亾鏈敞鍐屻€佽皟搴︽湭鍚姩锛宍input_gateway_status` 杩斿洖 fallback channels=0锛夈€?  鏀逛负 `.nullish()`锛堝悓鏃舵帴鍙?undefined 涓?null锛夛紝骞跺鐜板満瀛樺偍鏁版嵁鍋?null鈫? 淇
  锛堝浠?`agint_input_gateway.json.bak-20261003-124612`锛屾棤 BOM 鍐欏洖锛夈€?- **琛ュ洖褰掓祴璇?*锛坄test/storage-schema.test.mjs`锛夆€斺€旀柊澧炪€岀敓浜?adversarial 鏃ц褰曪紙security* 涓?null锛夊彲瑙ｆ瀽銆?  鐢ㄤ緥锛涚孩缁胯嚜璇侊細鏀瑰墠绾紙5 閫?4 杩?1 绾級銆佹敼鍚庡叏缁匡紙5/5锛夛紝鍏ㄩ噺 46/46 閫氳繃銆?
## 0.1.1 鈥?2026-09-29

> 0.1.0锛坄8dee9a9`锛変箣鍚庤嚦浠婄殑鏀瑰姩锛屾鍓嶆湭璁板綍锛屼竴骞惰ˉ涓婏紱鏈疆瀹氱涓?0.1.1銆?
### 鏂板

- **C2 sessionIntegrity 妫€娴嬪櫒瀹炶**锛坄lib/channels/self-observation.js`锛夆€斺€?.1.0 鐣欐帴鍙?P1 瀹炵幇
  - `detectSessionIntegrity`锛歾std 瑙ｅ帇鏈€杩?8 涓細璇濓紙澶嶇敤 agint-session-extract 鎺㈡祴閫昏緫锛夛紝妫€娴嬪潖琛?/ seq 鏂 / 缂?content / 鏈厤瀵?call锛屼骇鍑?session-integrity 淇″彿
  - 瀵煎嚭 `listRecentSessions` / `inspectSessionFile` 渚涘鐢ㄤ笌娴嬭瘯锛泎std 缂哄け杞檷绾ц繑鍥炵┖
  - `health()` 鏇存柊涓?`active: true`
- **security 妯″潡**锛坄lib/security.js` 鏂板缓锛夛細8 鏉″閮ㄤ俊鍙?prompt injection 瑙勫垯锛堜腑鑻辨寚浠ゅ姭鎸?/ 瑕嗙洊 / 韬唤鍔寔 / 绯荤粺鎻愮ず璇嶆帰娴?/ 浼€犳爣绛?/ 绱ф€ユ柦鍘嬶級
  - `checkExternalText` / `checkSignal` / `getSecurityRules` 瀵煎嚭
  - gateway 娴佺▼鎻掑叆 2.5 security 闂ㄧ锛歚securityAction=flag`锛堥粯璁わ紝鍛戒腑鏍囪鏀捐锛? `drop`锛堝懡涓涪寮冿級/ `off`锛堣烦杩囷級锛涙鏌ヨ寖鍥?external / adversarial / cross-agent 涓夌被澶栭儴淇″彿
  - 璁℃暟闈?`securityScanned/securityFlagged/securityDropped` + `getStatus().security{action,ruleCount,checkedTypes}`
- **C5 璺?Agent Channel**锛坄lib/channels/cross-agent.js` 鏂板缓锛夛細OV 妫€绱㈠閲?diff + 浼氳瘽鑱氱被 pattern + 璺?preset 鍙姒傝
  - 澧為噺鍘婚噸鐘舵€?`DSH_HOME/storages/agint_input_gateway_cross_agent_state.json`
  - 璋冨害 `C5_CRON=0 5 * * 0`锛堟瘡鍛ㄦ棩 05:00锛?- **adversarial 绌哄３浜嬩欢杞彂**锛歚forwardEmptyDiagnosis=true`锛堥粯璁わ級鏃?clusterCount=0 绌哄３ diagnosis 浜嬩欢杞彂涓?`counterfactual-empty-<reportId>` 淇″彿锛堝奖瀛愭湡璇婃柇閾剧┖杞彲瑙傛祴锛?- schema/storage 鎵╁睍锛歚CHANNEL_IDS.CROSS_AGENT`銆乣KNOWN_TOPICS` 鍔?cross-agent.diff/pattern銆乣ConfigSchema.securityAction/forwardEmptyDiagnosis`銆丆ountersSchema 鍔?security* 璁℃暟

- **C4 瀵规姉鎸戞垬 Channel**锛坄lib/channels/adversarial.js`锛夆€斺€?.1.0 鐨勩€屼笉鍋氫粈涔堛€嶆妸 C4 鍒椾负 P2锛屾湰娆℃彁鍓嶈惤鍦?  - 璁㈤槄 `diagnosis.completed` / `curriculum.challenge-verdicted` / `curriculum.boundary-probed`锛屽彧杞彂澶辫触涓庝笉鍙獙璇佽竟鐣?  - 鍏ラ槦鏉′欢锛歚clusterCount > 0` / `result === 'fail'` / `unverifiable` 闈炵┖锛涗笉婊¤冻鑰呴潤榛樹涪寮?  - cron `30 3 * * *`锛堟瘡鏃?03:30锛夛紝鎺掑湪 C2 `0 2 * * 0` 涔嬪悗銆丆3 `0 4 * * 0` 涔嬪墠
  - `health()` 鑷姤 `status` / `initError` / `queuedSignals` / `detectors`

### 淇

- `inject` 琛?`agint.compressGuard`鈥斺€旀鍓嶅帇缂╀涪澶卞瓙婧愭亽涓虹┖锛坄6155611`锛?- `optionalInject` 琛?`agint.eventBus.subscribe`锛坄bc92c21`锛夊強 `publish`锛坄ff620ee`锛?- adversarial 鐨?`_subscribed` 绉诲埌 `subscribe()` 鎴愬姛鍚庢墠缃綅鈥斺€斿彇鍒板嚱鏁颁笉瓒充互璇存槑璁㈤槄鎴愮珛锛屽惁鍒?`health()` 鍋囩豢锛坄ff620ee`锛?- `getChannelStatus` 闄勫姞 Channel 鑷姤 `health`锛坄babbda4`锛?- `input_gateway_channel_status` 鐨?render 杈撳嚭 `health` 娈碘€斺€攇ateway 宸叉寕涓婅瀛楁浣嗗伐鍏锋湭娓叉煋锛屽鑷?`initError` 涓嶅彲瑙侊紝璁㈤槄澶辫触涓庢垚鍔熷湪杈撳嚭閲屾棤娉曞尯鍒嗭紙`5553e5f`锛?- 娉ㄥ唽 Channel 鏀圭敤 `emptyChannelState` 鏇夸唬鎵嬪伐鏋勯€狅紙`c10e469`锛?
### 宸茬煡闂

- `package.json` 鐨?`exports` 鏈垪鍑?`./lib/channels/adversarial.js`锛圕4 钀藉湴鏃舵紡鏇达級锛屾寜璇ュ瓙璺緞 import 浼氳В鏋愬け璐?- adversarial 鐨勭湡瀹炴€荤嚎鎶曢€掓湭楠岃瘉锛氬叾涓変釜璁㈤槄 topic 鍦ㄧ敓浜ф€荤嚎涓婂皻鏃犲彂甯冭褰曪紝handler 閫昏緫宸插崟娴嬭鐩栵紙23 椤癸級锛岀鍒扮鎶曢€掑緟楠?
## 0.1.0 鈥?2026-09-29

### 鏂板

- **agint-input-gateway** 鎻掍欢 v0.1.0锛圥0锛夛細澶氭簮杈撳叆缃戝叧鏍稿績妗嗘灦
  - Gateway 涓冩ā鍧楋細scheduler / normalizer / filter / router / quota / security / observability
  - C2 绯荤粺鑷娴?Channel锛? 瀛愭簮锛夛細
    - toolStats 寮傚父妫€娴嬶紙澶辫触鐜?>30% 瑙﹀彂淇″彿锛?    - metrics 閫€鍖栨娴嬶紙閿欒璁℃暟 >10 瑙﹀彂淇″彿锛?    - 瑙勫垯楂橀鍛戒腑锛坉eny 瑙勫垯 鈮?0 鏉℃姤鍛婏級
    - 鍘嬬缉涓㈠け锛堣皟鐢?agint.compressGuard.stats() 妫€娴?BLOCKED/DEGRADED锛?    - session 瀹屾暣鎬э紙P0 鐣欐帴鍙ｏ紝P1 瀹炵幇锛?  - eventBus 闆嗘垚锛氫俊鍙峰綊涓€鍖栦负 `input.signal.<channelType>.<signalType>` topic 鍙戝竷
  - 杞檷绾э細eventBus 涓嶅彲鐢ㄦ椂闈欓粯锛屼笉褰卞搷涓绘祦绋?  - publish accepted 妫€鏌ワ細鍘嗗彶鏁欒锛坰kill-autocreate 涓嶆鏌ュ鑷撮潤榛樹涪寮冿級
  - 鍘婚噸锛?4h 婊氬姩绐楀彛锛宑hannelId+signalId 鍞竴
  - 鍣０鎶戝埗锛氬悓 source+signalType 1h 鍐呮渶澶?5 鏉?  - 閰嶉锛氭瘡 Channel 鏃ヤ笂闄愶紙C2 榛樿 50 鏉?鏃ワ級
  - payload 鎴柇锛氳秴杩?2KB 鑷姩鎴柇涓?summary

- **6 涓?model 宸ュ叿**锛?  - 鍙锛歚input_gateway_status` / `input_gateway_channel_status`
  - 鍐欐搷浣滐紙ask 闂ㄧ锛夛細`input_gateway_force_fetch` / `input_gateway_set_quota` / `input_gateway_channel_enable` / `input_gateway_channel_disable`

- **瀛樺偍鍩?*锛歚agint_input_gateway`锛? 琛細config / counters / dedup / channel_state锛宻chemaVersion 1锛?
### 璁捐鍐崇瓥锛坴1.1 鏂规纭锛?
- Q1=B锛氫汉绫绘剰鍥句笉缁忚繃 Gateway锛屽弽棣堟梺璺彂甯?- Q2=C锛欳hannel 鍒濊瘎 relevance锛孏ateway 璋冩暣
- Q3=C锛氫富鍔ㄦ媺涓轰富锛屼簨浠堕┍鍔ㄧ敤鎺ㄩ€侊紙P0 鍏ㄦ媺妯″紡锛?- Q4=B锛氬啓鎿嶄綔宸ュ叿 P0 鍗虫毚闇诧紝璧?rule_check ask 闂ㄧ
- Q5=A锛歱ayload 鈮?KB

### 涓嶅仛浠€涔堬紙P0 杈圭晫锛?
- 涓嶆帴 C3 澶栭儴涓栫晫锛坓it/web/渚濊禆锛夆€斺€擯1
- 涓嶆帴 C4 瀵规姉鎸戞垬鈥斺€擯2
- 涓嶆帴 C5 璺?Agent/OpenViking鈥斺€擯3
- 涓嶄慨鏀?memory/evolve/dream 鐨勬秷璐圭璁㈤槄鈥斺€擯1
- security 妯″潡涓烘帴鍙ｉ鐣欙紙C2 鏄唴閮ㄤ俊鍙凤紝涓嶉渶瑕?rules 闂ㄧ锛汸1 C3 澶栭儴淇″彿鍚敤锛?
