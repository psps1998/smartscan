# Putting Smartscan on the internet with AWS (beginner guide)

This guide assumes you have never used AWS. Follow the steps in order. It costs about **$3–8 per month**.

## The big picture

Right now Smartscan runs on your own PC, so it only works while your PC is on. We will rent a small computer from Amazon that stays on all the time, put Smartscan on it, and give it a web address.

Here are the words you will meet:

| Word | What it means |
|------|---------------|
| **AWS** | Amazon's service for renting computers and storage. |
| **EC2** | AWS's name for a rented computer ("instance"). We rent one. |
| **Instance** | The rented computer itself. |
| **Elastic IP** | A fixed street address for your computer. Without it, the address changes every time the computer restarts. |
| **Security group** | A firewall. A list of doors that are open to the internet. |
| **SSH** | A way to type commands on the rented computer from your PC. |
| **Domain** | A web address like `mygroceries.com`. |
| **HTTPS** | The padlock in the browser. It keeps your password private. |
| **S3** | AWS storage for files. We use it for backups. |

Why not a "serverless" AWS service? Smartscan keeps its data in one file (`data/inventory.db`). That file needs a normal disk that is always there. A normal rented computer gives you that, and it is also the cheapest option.

## Before you start
You need:
- An AWS account. Sign up at https://aws.amazon.com (needs a credit card).
- Your Anthropic API key (the one in your local `.env` file).
- About 1 hour.
- A domain name. You can buy one for about $12 a year, or use a free one from https://www.duckdns.org.

---

## Step 1: Rent the computer

1. Log in to the AWS Console (https://console.aws.amazon.com).
2. In the top right, pick a **region** (a location) close to you. Remember it.
3. In the search bar at the top, type **EC2** and open it.
4. Click the orange **Launch instance** button.
5. Fill in the form:
   - **Name:** `smartscan`
   - **Application and OS Images:** choose **Amazon Linux**. Make sure it says **Amazon Linux 2023** and the architecture is **64-bit (Arm)**.
   - **Instance type:** choose **t4g.micro**. This is the small, cheap computer.
   - **Key pair (login):** click **Create new key pair**. Name it `smartscan-key`, keep the defaults and click **Create**. A file called `smartscan-key.pem` downloads. **Keep it safe.** It is your password to get into the computer. If you lose it, you can't log in.
   - **Network settings:** click **Edit**, then set up the firewall like this:
     - Rule 1: SSH, source **My IP** (only you can log in).
     - Click **Add security group rule**: HTTP, source **Anywhere**.
     - Click **Add security group rule**: HTTPS, source **Anywhere**.
   - **Configure storage:** change 8 GiB gp3 only if you want more. 8 is fine.
6. Click **Launch instance**.

### Give it a fixed address
1. In the left menu of EC2, click **Elastic IPs**.
2. Click **Allocate Elastic IP address**, then **Allocate**.
3. Tick the new address, then click **Actions → Associate Elastic IP address**.
4. Under **Instance**, pick your `smartscan` instance and click **Associate**.
5. This is your fixed IP address. Yours is `3.6.206.107`, and the commands below already use it.

---

## Step 2: Point your domain at the computer

Go to the website where you bought your domain (or DuckDNS), and find the DNS settings. Add an **A record**:
- **Name:** `@` (or the subdomain you want)
- **Value:** `3.6.206.107`

It can take a few minutes to start working.

---

## Step 3: Log in to your rented computer

On your PC, open **PowerShell**. Go to the folder where your key file is (usually Downloads):

```powershell
cd $HOME\Downloads
ssh -i smartscan-key.pem ec2-user@3.6.206.107
```

Type `yes` if it asks about the fingerprint. You are now typing on the rented computer. Everything in the "on the server" boxes below runs here.

**If Windows complains the key file is "too open":** right-click the `.pem` file, choose Properties, then Security, then Advanced. Disable inheritance and make sure only your user has access.

Now install what Smartscan needs:

```bash
sudo dnf install -y nodejs22 sqlite git
node -v
```

The last command should print a number starting with `22` or higher. If the install fails because `nodejs22` can't be found, tell me what error you see and I'll help.

Create a separate user for the app. It is safer than running it as the main user:

```bash
sudo useradd -r -m -d /opt/smartscan smartscan
```

---

## Step 4: Copy Smartscan onto the computer

Open a **second PowerShell window** on your PC. Don't use the SSH one. This packs the app into one file, leaving out files that shouldn't travel:

```powershell
cd C:\Projects
tar --exclude=node_modules --exclude=data --exclude=.env -czf smartscan.tgz Smartscan
scp -i $HOME\Downloads\smartscan-key.pem smartscan.tgz ec2-user@3.6.206.107:/tmp/
```

Go back to the **server window** and unpack it:

```bash
sudo tar -xzf /tmp/smartscan.tgz -C /opt/smartscan --strip-components=1
sudo mkdir -p /opt/smartscan/data
sudo npm install --omit=dev --prefix /opt/smartscan
```

Don't try `cd /opt/smartscan`. The folder belongs to the `smartscan` user, so your normal login gets "Permission denied". Using `sudo` with the full path, as above, works.

---

## Step 5: Copy your existing data

Skip this step if you want to start with an empty app.

1. **Stop Smartscan on your PC** first. This makes sure the database file is complete.
2. In the **PC window**:

```powershell
scp -i $HOME\Downloads\smartscan-key.pem C:\Projects\Smartscan\data\inventory.db ec2-user@3.6.206.107:/tmp/
```

3. In the **server window**:

```bash
sudo mv /tmp/inventory.db /opt/smartscan/data/
```

---

## Step 6: Set your passwords

In the **server window**:

```bash
sudo nano /opt/smartscan/.env
```

This opens a simple text editor. Type this, with your own values:

```
ADMIN_USER=admin
ADMIN_PASSWORD=pick-a-long-password
SESSION_SECRET=any-long-random-text-like-kj83hf72hd9s0
ANTHROPIC_API_KEY=sk-ant-your-key-here
PORT=3000
```

Save and exit: press **Ctrl+O**, then **Enter**, then **Ctrl+X**.

- `ADMIN_USER` and `ADMIN_PASSWORD` log you in to the admin dashboard at `/admin` (it stays switched off without a password). Families create their own accounts with the **Signup** button and can log in straight away.
- Use a long, hard-to-guess password. The app will be on the public internet.

Lock the file down so only the app can read it:

```bash
sudo chown -R smartscan:smartscan /opt/smartscan
sudo chmod 600 /opt/smartscan/.env
```

---

## Step 7: Make Smartscan start by itself

We want the app to start when the computer boots and restart if it crashes.

```bash
sudo nano /etc/systemd/system/smartscan.service
```

Paste this:

```ini
[Unit]
Description=Smartscan
After=network.target

[Service]
User=smartscan
WorkingDirectory=/opt/smartscan
ExecStart=/usr/bin/node --env-file-if-exists=.env server.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Save and exit (**Ctrl+O**, **Enter**, **Ctrl+X**). Then start it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now smartscan
curl localhost:3000/session
```

You should see `{"loggedIn":false}`. That means the app is running.

If you don't, run `sudo journalctl -u smartscan -n 30` to see the error messages.

---

## Step 8: Add the padlock (HTTPS)

Right now the app is only reachable inside the computer. We install a helper program called **Caddy** that faces the internet and gets a free padlock certificate automatically.

In the **server window**:

```bash
sudo dnf install -y 'dnf-command(copr)'
sudo dnf copr enable -y @caddy/caddy epel-9-aarch64
sudo dnf install -y caddy
sudo nano /etc/caddy/Caddyfile
```

Delete everything in that file and replace it with this (use your own domain):

```
yourdomain.com {
    reverse_proxy localhost:3000
}
```

Save and exit, then start it:

```bash
sudo systemctl enable --now caddy
```

Now open `https://yourdomain.com` in your browser. You should see the Smartscan login page with a padlock.

**If you can log in but get sent back to the login page:** tell me. A small code change in `server.js` fixes it (`app.set('trust proxy', 1)`). It is needed because the app sits behind Caddy.

**If the page doesn't load:** check that your domain's A record is correct (step 2) and has had a few minutes to start working.

---

## Step 9: Set up backups

Your data lives on one disk. If something goes wrong, you could lose everything. Backups protect you.

1. In the AWS Console, open **S3** and click **Create bucket**. Give it a unique name like `smartscan-backups-yourname` and keep the defaults.
2. Open the bucket, go to **Management → Create lifecycle rule**. Name it `expire`, apply it to all objects, and tick **Expire current versions of objects** after **30** days. This deletes old backups so they don't pile up.
3. Open **IAM** (search at the top), then **Roles → Create role**:
   - Trusted entity: **AWS service**, use case **EC2**.
   - Click **Create policy** in a new tab, choose JSON, and paste (change the bucket name):
     ```json
     {
       "Version": "2012-10-17",
       "Statement": [{
         "Effect": "Allow",
         "Action": "s3:PutObject",
         "Resource": "arn:aws:s3:::smartscan-backups-yourname/*"
       }]
     }
     ```
   - Name the policy `smartscan-backup`, save, then pick it in the role screen. Name the role `smartscan-role`.
4. Go back to **EC2 → Instances**, tick your instance, and click **Actions → Security → Modify IAM role**. Pick `smartscan-role` and save.
5. In the **server window**, set up a nightly backup:

```bash
sudo crontab -u smartscan -e
```

Add this line at the bottom (change the bucket name). Save and exit. If you're asked to pick an editor, choose nano:

```
0 3 * * * sqlite3 /opt/smartscan/data/inventory.db ".backup /tmp/inv.db" && aws s3 cp /tmp/inv.db s3://smartscan-backups-yourname/inv-$(date +\%F).db
```

This runs at 3 AM every night. Test it once by hand:

```bash
sudo -u smartscan sh -c 'sqlite3 /opt/smartscan/data/inventory.db ".backup /tmp/inv.db" && aws s3 cp /tmp/inv.db s3://smartscan-backups-yourname/test.db'
```

Then look in your S3 bucket in the Console. You should see `test.db`.

---

## Step 10: Set a spending alert

So a surprise bill never catches you:

1. Search for **Billing** in the AWS Console and open **Budgets**.
2. Click **Create budget**, choose **Cost budget**, and set **$10** per month.
3. Add your email for alerts.

---

## Checking it all works
- Open `https://yourdomain.com`, log in, scan an invoice, and add an item.
- In the AWS Console, tick your instance and click **Instance state → Reboot instance**. After a minute or two, the site should come back by itself with your data.
- Check that a backup file appears in S3 the morning after.

## Updating the app later
When you change the code on your PC:

1. Repeat step 4 (the `tar` and `scp` commands on your PC, then the unpack on the server).
2. In the server window run:
   ```bash
   sudo systemctl restart smartscan
   ```

Never copy over the `data` folder. That would replace your live data.

## What it costs
| Item | About |
|------|-------|
| The rented computer (t4g.micro) | $6/month |
| Disk (8 GB) | $0.70/month |
| Fixed IP address | Free while the computer is running |
| Backups in S3 | A few cents |
| Domain name | $12/year (or free with DuckDNS) |
| Anthropic invoice scanning | A few cents per scan, billed by Anthropic, not AWS |

Prices change and vary by region, so check the AWS pricing page. New AWS accounts sometimes get free credits.

**Things that quietly cost a lot:** load balancers (about $16/month), NAT gateways (about $32/month) and databases (RDS). You don't need any of them. Don't add them.

## If you get stuck
- **Can't log in with SSH:** check the security group allows port 22 from your *current* IP address. Your home IP can change.
- **Site not loading:** run `sudo systemctl status smartscan` and `sudo systemctl status caddy` on the server. Both should say `active (running)`.
- **App crashes on start:** run `sudo journalctl -u smartscan -n 30` to see why.
