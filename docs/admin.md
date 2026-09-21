# 绠＄悊鍛橈細閮ㄧ讲銆佹槧灏勩€佽縼绉讳笌鎭㈠

## 鍗曚腑蹇冦€佺洿鎺?Node 浼樺厛

鍥㈤槦鍙繍琛屼竴浠戒腑蹇冿紝鎵€鏈夋秷鎭繚瀛樺湪鍏?SQLite銆侼ode.js **24**銆丒SM JavaScript銆佸唴缃?node:sqlite 鍜屽畼鏂?MCP SDK锛涙簮鐮佹牴鐩綍 `npm ci`锛屽惎鍔?`npm start`銆傛垚鍛樺彧闇€瑕佹簮鐮佷緷璧栦笌 bridge锛屼笉闇€瑕佹湰鍦?DB銆?
| 鐜鍙橀噺 | 榛樿 |
| --- | --- |
| `MSG_HOST` | `127.0.0.1` |
| `MSG_PORT` | `8787` |
| `MSG_DB_PATH` | 褰撳墠宸ヤ綔鐩綍涓?`data/msg.sqlite` |
| `MSG_ACCESS_CONFIG` | 褰撳墠宸ヤ綔鐩綍涓?`access.json` |

鎺ㄨ崘 DB 鍜岄厤缃潎浣跨敤缁濆璺緞銆俙.env` 涓嶈嚜鍔ㄥ姞杞斤紱PowerShell `$env:鍙橀噺 = '鍊?` 鍙奖鍝嶅綋鍓嶇粓绔強鍚庣画瀛愯繘绋嬨€傚師鐢熶腑蹇冨墠鍙?Ctrl+C 鍋滄锛岄暱鏈熸墭绠＄敱绠＄悊鍛橀噰鐢ㄧ幇鏈夎繘绋嬬鐞嗘柟寮忥紝鏈」鐩笉鎻愪緵涓撶敤瀹夎鍣ㄣ€?
## JSON 鏄犲皠

`access.example.json` 鍙彁渚?loopback 鍗曚汉鎴愬憳 A 婕旂ず銆傚洟闃熺ず鎰忥紙IP 浠呬负鏂囨。绀轰緥锛夛細

```json
{
  "allowedCidrs": ["192.168.50.0/24", "127.0.0.0/8", "::1/128"],
  "members": [
    { "name": "A", "ips": ["192.168.50.21"] },
    { "name": "B", "ips": ["192.168.50.22", "192.168.50.23"] },
    { "name": "Admin", "ips": ["127.0.0.1", "::1"] }
  ]
}
```

涓€涓垚鍛樺彲瀵瑰簲澶?IP锛涙墍鏈夎繖浜?IP 鍏变韩鍚屼竴鏀朵欢绠卞拰宸茶銆傛垚鍛樺悕缁?trim 鍚庡厑璁?Unicode 瀛楁瘝/鏁板瓧銆佷笅鍒掔嚎銆佽繛瀛楃锛?鈥?2 涓?UTF-16 鐮佸厓銆傛病鏈?displayName 閰嶇疆瀛楁锛孉PI 涓哄吋瀹逛簲宸ュ叿缁撴灉杩斿洖 displayName=name銆?
鏍￠獙閲囩敤鎴愮啛 `ipaddr.js` 瑙ｆ瀽鍜?CIDR 鍖归厤锛屼娇鐢?Node `net.isIP` 鎷掔粷缂╁啓/鍏繘鍒?IPv4銆侷Pv4-mapped IPv6 瑙勮寖鍖栧埌 IPv4锛屽洜姝?`127.0.0.1` 涓?`::ffff:127.0.0.1` 涓嶈兘閲嶅缁戝畾锛涘悓涓€鎴愬憳鍐呴噸澶嶄篃澶辫触銆傛棤 zone 鐨勬爣鍑?IPv6 鍙敤锛沵apped CIDR 蹇呴』鑷冲皯 /96锛屽啀鎹㈢畻涓?IPv4 鍓嶇紑銆傞厤缃瓧娈典弗鏍兼牎楠岋紝涓嶆帴鍙椾换鎰忛澶栬韩浠藉瓧娈点€?
缂烘枃浠躲€佸潖 JSON銆佺┖ allowedCidrs/members銆侀潪娉?CIDR/IP銆侀噸澶?name銆侀噸澶嶈鑼?IP銆佺┖ ips 鎴栦换浣曟垚鍛?IP 瓒呭嚭鐧藉悕鍗曪紝鍧?*鍦ㄦ墦寮€ DB 鍓嶅惎鍔ㄥけ璐?*銆傛病鏈夐粯璁ゆ斁琛屾垨鍑嵁鍥為€€銆?
```powershell
Set-Location -LiteralPath 'D:\team-mailbox'
$env:MSG_ACCESS_CONFIG = 'D:\team-mailbox\access.json'
npm run admin -- validate-config
npm run admin -- list-members
```

杩欎袱涓懡浠ゅ彧璇婚厤缃紝涓嶅垱寤?DB锛沴ist-members 鍒楀嚭褰撳墠鏂囦欢鐨勮鑼?IP銆備腑蹇冨姞杞界殑鏄惎鍔ㄥ揩鐓э細淇敼鍚庡厛鏍￠獙锛屽啀閲嶅惎涓績銆傚仠姝㈠墠鍦ㄩ€旇姹傚彲鑳戒粛瀹屾垚锛屾挙閿€鎿嶄綔搴旇€冭檻鍋滄湇杈圭晫銆?
### 娣诲姞銆佷慨鏀广€佸垹闄ゆ垚鍛?
- **娣诲姞**锛氱粰 JSON members 澧炲姞鍞竴 name/ips锛岀‘淇?IP 鍦ㄧ櫧鍚嶅崟鍐咃紱鏍￠獙銆侀噸鍚€?- **鎹?IP/澧炲姞璁惧**锛氫慨鏀瑰悓涓€鎴愬憳 ips锛涙牎楠屻€侀噸鍚紝鏃?IP 鑻ュ垹闄ゅ垯涓嶈兘鍐嶈闂€?- **鎾ら攢**锛氬垹闄ゆ暣涓垚鍛橀」鎴栧叾 IP锛堜笉鑳界暀涓嬬┖ ips锛夛紱鏍￠獙銆侀噸鍚€傝鎴愬憳涓嶅啀鏈夋柊鏀朵欢璧勬牸锛屽巻鍙叉暟鎹繚鐣欍€?- **閲嶆柊鍔犲叆/鏀瑰悕**锛氬悓鍚嶄細閲嶆柊鑾峰緱鍘熸敹浠剁锛涙敼鍚嶆槸鏂拌韩浠斤紝涓嶈縼绉诲巻鍙层€備笉瑕佹妸鏃?name 澶嶇敤缁欏彟涓€涓汉銆?
浣跨敤鍥哄畾 IP 鎴?DHCP 淇濈暀锛屽苟绠＄悊 IPv6 鍦板潃绋冲畾鎬э紱IP 琚缁欏彟涓€鍙拌澶囧彲鑳藉鑷磋璁ゃ€侷P 鏄綉缁滆闂害瀹氾紝**涓嶆槸寮鸿韩浠借璇?*銆傚悓涓€ NAT/浠ｇ悊/鍏变韩鐢佃剳 IP 涔嬪悗鐨勭敤鎴锋棤娉曞尯鍒嗐€?
## 鏄惧紡寮€鏀?LAN锛堢敱绠＄悊鍛樻搷浣滐紝鏈疆鏈墽琛岋級

1. 纭畾鐪熷疄鎴愬憳鏉ユ簮鍦板潃銆佺櫧鍚嶅崟銆佹湇鍔＄綉鍗′互鍙婇檺瀹氭潵婧愮殑闃茬伀澧欒鍒欙紝绂佹鍏綉鍏ュ彛銆?2. 缂栬緫骞舵牎楠?access.json锛涗繚鐣欑鐞嗗憳鏉ユ簮浠ヤ究浠庡叾鏈哄櫒杩愯 health/doctor銆侰IDR 閫氳繃浠嶉渶鏈夋垚鍛樻槧灏勶紝health 涔熶笉渚嬪銆?3. 鍋滄涓績锛屽湪鍚姩缁堢璁剧疆瀹為檯缃戝崱鍦板潃锛屼緥濡?`$env:MSG_HOST = '192.168.50.10'`銆傝嫢閫?`0.0.0.0` 浼氱洃鍚叏閮?IPv4 缃戝崱锛屽彧搴斿湪闃茬伀澧欒寖鍥寸‘璁ゅ悗閫夋嫨銆?4. 浣跨敤鍚屼竴 DB 缁濆璺緞閲嶅惎銆傚悜鍚屼簨鎻愪緵瀹為檯鏈嶅姟 URL锛屼笉鏄?`0.0.0.0`銆?5. **姣忓彴鎴愬憳鏈哄櫒**杩愯 doctor锛岀‘璁ゆ湇鍔¤瘑鍒殑 member 姝ｇ‘鍚庢墠杩涜鍙屾柟鍚屾剰鐨勬祴璇曟敹鍙戙€?
鏈嶅姟鍙敤 `req.socket.remoteAddress`锛屼笉閲囦俊 Forwarded/X-Forwarded-For/Authorization/鑷姤鍚嶅瓧锛涘嵆浣垮湪浠ｇ悊鍚庝篃涓嶄細鏀瑰彉姝よ鍒欍€侶TTP 鏄庢枃浠呭彲淇?LAN锛涜嫢闇€瑕?TLS锛屽簲閲囩敤缁忛獙璇佷繚鐣欐潵婧愮殑浼犺緭閮ㄧ讲锛屾櫘閫?TLS 鍙嶅悜浠ｇ悊浼氳涓績鐪嬪埌浠ｇ悊 IP锛屼笉鑳界畝鍗曟斁琛屼唬鐞嗗苟鍋囧畾韬唤宸插尯鍒嗐€傛湰娆℃病鏈変慨鏀圭綉缁溿€侀槻鐏鎴栧鎴风閰嶇疆銆?
## 鏃ф暟鎹簱杩佺Щ涓庡崌绾?
鏃х増閲囩敤涓汉鍑嵁琛ㄣ€傚崌绾у悗婧愮爜娌℃湁鏃ц璇?鎴愬憳鍒涘缓杞崲鎾ら攢 CLI锛屾病鏈夊嚟鎹幆澧冨彉閲忔垨璁よ瘉 fallback銆?
1. **鍗囩骇鍓嶅厛澶囦唤**鐜版湁 DB 鍜岄儴缃插弬鏁帮紝鍒涘缓骞舵牎楠屾柊 access.json銆備负闇€瑕佷繚鐣欐敹浠剁鐨勬垚鍛樹娇鐢ㄥ師 name锛涙柊閰嶇疆鏄敮涓€鎺堟潈鏉ユ簮锛屾棫鏁版嵁搴撶殑 revoked_at 涓嶅啀鍐冲畾璁块棶鏉冮檺銆?2. 鍋滄鏃ф湇鍔°€佹浛鎹㈡簮鐮佸拰 lockfile銆丯ode 24 涓?`npm ci`锛岃缃悓涓€ DB 璺緞鍙婃柊 access.json銆?3. 鏂颁腑蹇冨惎鍔ㄦ椂鍏堥獙璇侀厤缃紝鍐嶅紑鍚?DB锛泂chema 鍒濆鍖?杩佺Щ鍦ㄤ簨鍔′腑鎵ц锛?*鍒犻櫎鏃?tokens 琛ㄥ強鍏剁储寮?*锛屼繚鐣?members 鍘嗗彶琛屼笌 messages銆傛秷鎭?id銆佹枃鏈€侀」鐩€乺eply_to銆乺ead_at銆佸垱寤烘椂闂村拰鑷搴忓垪涓嶉噸鍐欍€傛柊閰嶇疆缂哄皯鐨勬棫鎴愬憳浠嶄繚鐣欑敤浜庡閿紝浣嗕笉鑳借闂垨鎴愪负鏂版敹浠朵汉銆?4. 灏嗘柊閰嶇疆鎴愬憳 INSERT OR IGNORE 鍒板巻鍙?members 琛紱褰撳墠 peers 浠庨厤缃繑鍥炪€傛棫 display_name/revoked_at 鍙綔鍘嗗彶鍏煎鍒楋紝涓嶅綋鎺堟潈銆?5. 鏍稿 doctor銆佸綋鍓嶆垚鍛樸€佸巻鍙叉秷鎭互鍙婂彈鎺ф敹鍙戙€傛湭鏉ユ湭鐭?schema 鍗囩骇涓嶈兘鎹淇濊瘉鑷姩鍏煎锛涘綋鍓嶅彧鏄庣‘鏀寔浠撳簱鏃х増鍒版湰 IP 鏂规鐨勮縼绉汇€?
杩佺Щ涓嶄涪娑堟伅锛屼絾涓嶈兘鐩存帴鐢ㄦ棫绋嬪簭鍥炴粴鍒板凡鍒犻櫎鍑嵁琛ㄧ殑鏂?DB銆傝鍥炴粴鏃х増鏈紝椤诲仠鏈嶅悗鎭㈠**鍗囩骇鍓嶅浠藉強鏃т唬鐮?*锛屼細澶卞幓澶囦唤鍚庣殑鏂版秷鎭紱鍏堢‘璁や笟鍔℃帴鍙楄鍥為€€杈圭晫銆備笉瑕佽鏃с€佹柊涓績鍚屾椂鎵撳紑鍚屼竴 DB銆?
## 澶囦唤锛歏ACUUM INTO

```powershell
$env:MSG_DB_PATH = 'D:\team-mailbox\data\msg.sqlite'
npm run admin -- backup 'D:\msg-backups\msg-20260920-01.sqlite'
```

admin backup 鍙鎵撳紑鏃㈡湁婧?DB锛屼笉鍒濆鍖?杩佺Щ锛涘疄闄呮墽琛?SQLite `VACUUM INTO ?` 鍒涘缓涓€鑷寸殑鐙珛鏁版嵁搴撴枃浠躲€傜洰鏍囧繀椤讳笉瀛樺湪锛堟嫆缁濊鐩栵級锛岀己鐖剁洰褰曚細鍒涘缓銆傚彲鍦ㄧ嚎澶囦唤锛屾敞鎰忕┖闂茬┖闂淬€佹潈闄愬拰閿佺瓑寰咃紝绻佸繖鏃跺彲澶辫触鍚庨€夋嫨浣庡嘲閲嶈瘯銆備笉鏄儹澶嶅埗杩愯涓殑涓?DB銆?
澶囦唤 JSON 鏄犲皠鍜岄儴缃插弬鏁伴渶鍗曠嫭淇濆瓨锛孌B 澶囦唤涓嶅寘鍚?access.json銆傛墍鏈夊浠藉惈鏄庢枃娑堟伅锛屽簲闄愬埗鏂囦欢璁块棶銆傜敤浠ヤ笅鍛戒护妫€鏌ヤ骇鐗╋細

```powershell
npm run doctor -- --db-path 'D:\msg-backups\msg-20260920-01.sqlite' --skip-server
```

棣栨杩佺Щ鍓嶄篃鍙娇鐢ㄦ柊 admin backup 澶囦唤鏃у簱锛涘畠涓嶄細鎵ц DROP TABLE銆傚畬鏁存仮澶嶆紨缁冧粛闇€鍦ㄩ殧绂荤幆澧冨畬鎴愩€?
## 鎭㈠锛氬仠鏈嶅姟骞堕殧绂绘棫 WAL

娌℃湁 restore CLI銆傛仮澶嶇洰鏍囧繀椤绘槑纭紝绂佹閫氶厤/閫掑綊娓呯┖鏁版嵁鐩綍銆?
1. 楠岃瘉澶囦唤鍙墦寮€銆佸畬鏁存€т笌 schema 姝ｇ‘锛岀‘瀹?DB 鐩爣缁濆璺緞銆佷唬鐮佺増鏈拰瀵瑰簲鏄犲皠閰嶇疆銆?2. 鍋滄涓績锛屽叧闂墍鏈?admin/doctor/SQLite 杩涚▼锛岀‘璁ゆ病鏈夊叾浠栬繘绋?瀹瑰櫒璁块棶鍚屼竴 DB銆?3. 鍒涘缓涓€涓叏鏂扮┖闅旂鐩綍锛岄€愪竴绉昏蛋鏃?`msg.sqlite` 鍜屽瓨鍦ㄦ椂鐨?`msg.sqlite-wal`銆乣msg.sqlite-shm`锛屼繚鐣欎负鍚屼竴鏃х姸鎬侀泦鍚堛€備换涓€姝ュけ璐ュ氨鍋滀笅璋冩煡銆?4. 纭鐩爣浣嶇疆鏃犳棫涓诲簱/WAL/SHM锛屽啀灏嗙嫭绔嬪浠藉鍒朵负鐩爣 `msg.sqlite`锛涗笉瑕佸鍒舵棫 WAL/SHM 鍥炲幓銆?5. 浣跨敤 doctor 鐨勬樉寮忓彧璇?DB 妫€鏌ワ紝鏍稿鎭㈠鐨?access.json 鍜屾垚鍛樺垎閰嶏紝鍐嶅惎鍔ㄤ腑蹇冦€傝韩浠藉彇鍐充簬 JSON锛屼笉浠庢棫澶囦唤鑷姩鎭㈠锛涙棫娑堟伅閲嶆柊鍑虹幇鏃跺悓浜嬪簲鍒锋柊缂撳瓨鐨?id 閫夋嫨銆?
鑻ョ洰鏍囨槸 `D:\team-mailbox\data\msg.sqlite`锛屽彧澶勭悊杩欎笁涓簿纭矾寰勶細

```text
D:\team-mailbox\data\msg.sqlite
D:\team-mailbox\data\msg.sqlite-wal
D:\team-mailbox\data\msg.sqlite-shm
```

鏃ф枃浠跺湪鎭㈠纭鍓嶄繚鐣欙紝涓嶈兘浠呰鐩栦富鏂囦欢娣风敤鏃?WAL銆傚畾鏈熷湪鐙珛鐩綍婕旂粌锛岄伩鍏嶉娆℃晠闅滄椂鎵嶉獙璇佹祦绋嬨€?
## Docker锛氬彈闄愬弬鑰冿紝涓嶆帹鑽愰粯璁ゅ洟闃熻韩浠介儴缃?
**褰撳墠 Docker 涓嶅彲鐢紝鏈疆鏈墽琛屾瀯寤恒€侀儴缃叉垨鎭㈠銆?* NAT/妗岄潰 Docker/绔彛杞彂鍙兘鏇挎崲鏉ユ簮 IP銆傚綋鍓嶅疄鐜颁笉淇′换浠ｇ悊澶达紝Docker 鍚姩鎴愬姛涔熶笉璇佹槑鑳藉鍖哄垎鎴愬憳锛涗笉鑳芥妸缃戝叧 IP 鏄犲皠涓烘煇浜哄悗瀹ｇО鎵€鏈夊悓浜嬪凡鎺ュ叆銆?
Dockerfile 鍩轰簬 `node:24-alpine`銆侀暅鍍忓唴 `npm ci --omit=dev`銆佸伐浣滅洰褰?`/app`銆侰ompose 灏?`/data` 鎸傚埌鍛藉悕鍗?`msg-data`锛岀墿鐞嗗嵎鍚嶇敱椤圭洰鍚嶅喅瀹氾紱鍙缁戝畾瀹夸富 `access.json` 涓?`/app/access.json`锛岀己鏂囦欢鎷掔粷鍒涘缓鐩綍浠ｆ浛銆傚涓婚粯璁ゅ彧鍙戝竷 `127.0.0.1:8787:8787`锛屽鍣ㄥ唴鐩戝惉 `0.0.0.0`銆?
鍏堢敱绠＄悊鍛樺湪闅旂鐜璇佹槑鏉ユ簮淇濈湡锛屽啀鑰冭檻閮ㄧ讲銆傛簮鐮佺洰褰曚笅鍙傝€冨懡浠わ細

```powershell
docker compose build msg-server
docker compose up -d msg-server
docker compose ps
docker compose logs --tail 100 msg-server
docker compose exec msg-server node src/admin.js validate-config
docker compose exec msg-server node src/admin.js list-members
```

閫愭潯妫€鏌ラ€€鍑虹爜銆侰ompose 鍥哄畾 MSG_ACCESS_CONFIG/MSG_DB_PATH/MSG_HOST/MSG_PORT锛屼笉鑷姩鍔犺浇瀹夸富 `.env` 鍚屽悕鍊笺€傛洿鏂?bind 閰嶇疆鏂囦欢鍚庡簲閲嶅缓鏈嶅姟瀹瑰櫒浠ョ‘淇濇槧灏勬枃浠舵洿鏂帮紝渚嬪 `docker compose up -d --force-recreate msg-server`锛涗笉瑕佸亣瀹氬鍣ㄥ唴 loopback doctor 浠ｈ〃瀹夸富/鎴愬憳璺緞銆?
澶囦唤浠嶄娇鐢ㄧ浉鍚屽嵎涓殑 VACUUM INTO 浜х墿锛?
```powershell
docker compose exec msg-server node src/admin.js backup /data/backups/msg-20260920-01.sqlite
docker compose cp msg-server:/data/backups/msg-20260920-01.sqlite 'D:\msg-backups\msg-20260920-01.sqlite'
```

瀵煎嚭鍓嶇‘璁ゅ涓荤埗鐩綍瀛樺湪銆佺洰鏍囦笉瀛樺湪銆傚彧鐣欏湪鍘熷嵎鐨勫浠戒笉鑳藉簲瀵瑰嵎鎹熷潖銆?
### Docker 鍋滄湇鎭㈠鍙傝€?
淇濇寔鍚屼竴 Compose 椤圭洰鍙婂師鏈嶅姟瀹瑰櫒锛屼笉鍒犻櫎鍗枫€傚仠姝㈡墍鏈夊悓鍗疯闂€咃細

```powershell
docker compose stop msg-server
docker compose run --rm --no-deps --entrypoint sh msg-server
```

涓嬪垪鏄淮鎶ゅ鍣ㄥ唴鐨?**Linux sh**锛屼笉鏄?PowerShell锛涙瘡姝ユ垚鍔熷悗缁х画锛岄殧绂荤洰褰曞繀椤诲叏鏂帮細

```sh
mkdir /data/pre-restore-20260920-01
mv /data/msg.sqlite /data/pre-restore-20260920-01/msg.sqlite
if [ -e /data/msg.sqlite-wal ]; then mv /data/msg.sqlite-wal /data/pre-restore-20260920-01/msg.sqlite-wal; fi
if [ -e /data/msg.sqlite-shm ]; then mv /data/msg.sqlite-shm /data/pre-restore-20260920-01/msg.sqlite-shm; fi
exit
```

鍥炲埌 PowerShell锛岀‘璁ゆ棤鏃?WAL/SHM锛屽啀澶嶅埗鍒颁粛瀛樺湪鐨勫凡鍋滄湇鍔″鍣ㄧ殑鎸傝浇鍗凤細

```powershell
docker compose cp 'D:\msg-backups\msg-20260920-01.sqlite' msg-server:/data/msg.sqlite
docker compose run --rm --no-deps msg-server node src/doctor.js --db-path /data/msg.sqlite --skip-server
docker compose start msg-server
```

鏍稿鎵€鏈夎€?鏉冮檺銆丣SON 鏄犲皠鍜屾潵婧愪繚鐪熷悗鍐嶅厑璁告垚鍛樿闂€傚崌绾ч暅鍍忓墠淇濈暀鏃х増鏈?闀滃儚鏍囪瘑锛屼笉鑳藉彧璁?latest锛涘悓涓€椤圭洰 `build` 鍚?`up -d` 淇濈暀鍛藉悕鍗枫€傛潵婧愰棶棰樻湭楠岃瘉鍓嶏紝涓嶅皢 Docker 绀轰緥浣滀负鍥㈤槦鍙敤鏂规銆?