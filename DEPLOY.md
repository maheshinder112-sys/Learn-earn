# Learn and Earn: go live (phone only)

Files in this folder: `index.html` (website), `server.js`, `package.json`.
Upload ALL THREE files at the top level (no folder).

## 1. GitHub (stores your files)
1. Open github.com in your phone browser, tap Sign up, make a free account.
2. Tap the "+" at the top, then "New repository". Name: `learn-and-earn`. Choose **Private**. Tap "Create repository".
3. Tap "uploading an existing file". Choose the 3 files. Tap "Commit changes".
   (If upload is hard on mobile, switch your browser to "Desktop site" mode.)

## 2. Database (stores users, wallet, team)
1. Open render.com, sign up with GitHub.
2. Tap "New" > "PostgreSQL". Name: `lae-db`. Create it.
3. When it is ready, copy the **Internal Database URL**.

## 3. Server (runs the website)
1. On Render tap "New" > "Web Service". Connect your `learn-and-earn` repository.
2. Build Command: `npm install`   Start Command: `npm start`
3. Open "Environment" and add 3 variables:
   - DATABASE_URL = (paste the Internal Database URL)
   - ADMIN_EMAIL = ratandeeps123748@gmail.com
   - ADMIN_PASSWORD = (your admin login password, at least 10 characters, hard to guess)
4. Tap "Create Web Service". Wait until it says "Live". Open the link Render gives you. That link is your website.

The database tables are created automatically on first start. Your admin account is also created automatically.

## 4. Test
1. Open your link, tap Menu > Login, sign in with ADMIN_EMAIL and ADMIN_PASSWORD.
2. Make a test account on another phone (Sign up, Wallet or UPI).
3. Sign in on a second device with the same account: your data should be the same.
4. Wallet: Recharge, then in admin "Verification" tap Confirm. Balance should rise and Wallet Logs should show it.
5. Admin "Verification" must NOT be visible to a normal user.

Never share DATABASE_URL or ADMIN_PASSWORD with anyone.

## Security notes
- Passwords are stored hashed. Login sessions use a secure cookie that JavaScript cannot read.
- 5 wrong passwords lock that account for 15 minutes.
- Use the website only through its https link.
- In Render, turn on database backups (check the plan) so data is not lost.
- Change ADMIN_PASSWORD in Render if you ever think someone saw it.
