# Mail Tracker for Gmail

一個最小可用的 Gmail 郵件開信追蹤工具，用來知道自己寄出的信有沒有被收到／讀取。
採用業界標準的 **透明追蹤像素**（1×1 透明圖片），**不加任何可見簽名或浮水印**。

- `server/` — Node.js 後端：追蹤像素、記錄開信、儀表板、手機推播、雲端 DB
- `extension/` — Chrome 擴充：寄信自動塞隱形像素 + 桌面即時通知

---

## ☀️ 早上檢查清單（給你的三個動作）

程式我全部寫好也測過了。剩下這三件**只有你本人能做**（要你的帳號登入），
每件都是複製貼上等級：

**動作 1：建免費雲端資料庫（解決資料被清空）** — 約 3 分鐘
1. 去 https://neon.tech 用 Google 登入 → 建一個 project
2. 複製它給的 **Connection string**（長得像 `postgresql://user:pass@host/db`）
3. 先留著，下一步要貼到 Render

**動作 2：部署後端到 Render** — 約 5 分鐘
1. 把本專案推到 GitHub（指令見下方「部署到 Render」）
2. https://render.com 登入 → New + → Blueprint → 選此 repo（會自動讀 `render.yaml`）
3. 部署設定頁的 **Environment** 加兩個環境變數：
   - `DATABASE_URL` = 動作 1 複製的 Neon 連線字串
   - `NTFY_TOPIC` = 自己隨便想一個別人猜不到的字串，例如 `mailtrack-王小明-x9f2`
4. 部署完成，複製 Render 給的網址，例如 `https://mailtrack-server-xxxx.onrender.com`

**動作 3：把網址填進擴充，裝到 Chrome** — 約 3 分鐘
1. 用動作 2 的網址，取代這三個檔案裡的 `localhost:3000`：
   `extension/content.js`、`extension/popup.js`、`extension/background.js`、
   以及 `extension/manifest.json` 的 `host_permissions`
2. `chrome://extensions` → 開發人員模式 → 載入未封裝項目 → 選 `extension/`
3.（要手機推播才需要）手機裝 **ntfy** App → 訂閱動作 2 設的 `NTFY_TOPIC`

完成後：你寄信 → 對方開信 → 電腦跳桌面通知、手機跳 ntfy 推播、儀表板顯示已讀。

> 想先在自己電腦試跑、不碰雲端？看下面「本機測試」即可，不用做上面三步。

---

## 本機測試（可選，不碰雲端）

### 1. 啟動後端

```bash
cd server
npm install
npm start
```

看到 `Mail tracker running → http://localhost:3000` 就成功了。
打開 http://localhost:3000 會看到儀表板。

### 2. 安裝 Chrome 擴充

1. Chrome 開 `chrome://extensions`
2. 右上角開啟「開發人員模式 / Developer mode」
3. 點「載入未封裝項目 / Load unpacked」，選 `extension/` 資料夾
4. 重新整理 Gmail 分頁

之後你在 Gmail 正常寫信、按「傳送」，擴充會自動：
- 在信件最後塞一個隱形像素（對方完全看不到）
- 把這封信登記到後端

對方開信時，他的信箱會載入那張圖 → 後端記下時間 → 儀表板和擴充彈窗顯示「已讀」。

---

### ⚠️ 重點：要真的能用，後端必須是「公開網址」

`localhost:3000` 只有你自己的電腦連得到。對方開信時是**他的 Gmail** 去抓那張圖，
抓的是你 `SERVER` 設定的網址。所以正式使用要部署到公開網址（見下方 Render）。

部署後，把下列檔案裡的 `localhost:3000` 改成你的公開網址：
- `extension/content.js`、`extension/popup.js`、`extension/background.js` 最上面的 `SERVER`
- `extension/manifest.json` 的 `host_permissions`（把 localhost 那行換成你的網址 `/*`）
重新載入擴充即可。

### 環境變數（部署時設定）

| 變數 | 作用 | 範例 |
|---|---|---|
| `DATABASE_URL` | 設了就用雲端 Postgres（資料不被清空）；不設則用本機 JSON | `postgresql://…`（Neon/Supabase 給的） |
| `NTFY_TOPIC` | 設了就開手機推播；去 ntfy App 訂閱同一字串 | `mailtrack-王小明-x9f2` |
| `PORT` | 伺服器埠，Render 會自動帶入 | （免設） |

---

## 已知限制（所有追蹤工具共通，不是 bug）

- **Gmail 圖片代理快取**：Gmail 透過 `googleusercontent.com` 代理並快取圖片。
  第一次開信通常抓得到；重複開啟可能被快取擋住，次數不一定準。
- **預抓造成假開啟**：Gmail 有時會預先抓圖，程式已用 `viaProxy` 標記並對 5 秒內的
  重複請求去重，但無法 100% 排除。
- **對方關圖 / 用反追蹤工具**（Trocker、Ugly Email、ProtonMail）時追不到，
  且對方可能會看到你在追蹤。信照收、不影響你的帳號，只是隱私層面對方會知道。
- **不要拿來群發陌生信**：帳號風險來自「大量寄信被標垃圾」，跟追蹤像素無關。

## 部署到 Render（用 render.yaml 一鍵部署）

1. 把整個專案推到 GitHub：
   ```bash
   git init && git add . && git commit -m "mail tracker"
   git branch -M main
   git remote add origin https://github.com/你的帳號/你的repo.git
   git push -u origin main
   ```
2. 到 https://render.com 登入 → **New +** → **Blueprint** → 選這個 repo。
   Render 會自動讀取根目錄的 `render.yaml`，建出一個 web service。
3. 部署完成後會給你一個網址，例如 `https://mailtrack-server-xxxx.onrender.com`。
4. 把這個網址填回擴充：
   - `extension/content.js` 最上面的 `SERVER`
   - `extension/popup.js` 最上面的 `SERVER`
   - `extension/manifest.json` 的 `host_permissions`（把 localhost 那行換成你的網址 + `/*`）
   - 到 `chrome://extensions` 重新載入擴充

### ⚠️ Render 免費方案的兩個坑（一定要知道）

1. **閒置會休眠**：免費服務 15 分鐘沒人用就睡著，下次被叫醒要約 30 秒冷啟動。
   如果對方剛好在你服務休眠時開信，那次冷啟動延遲期間 **有可能漏記一次開啟**。
   → 解法：升級 Render 付費 $7/月保持不休眠，或用 cron 每 10 分鐘 ping 一次 `/`。
2. **檔案系統是暫時的**：`data.json` 存在容器裡，**每次重新部署或休眠醒來都會被清空**。
   → 解法：掛 Render 的 Persistent Disk（付費），或把儲存換成免費雲端資料庫
     （例如 Supabase / Neon Postgres、Upstash Redis）。要的話我可以幫你改。

本機測試不受這兩點影響，先在本機跑通再上雲。

## 資料儲存

開信記錄存在 `server/data.json`（純 JSON 檔）。要清空就刪掉這個檔。
正式上線建議改接雲端資料庫（見上方 Render 坑 2）。
