# Anonymous Chat (Fun Friday Group)
1. **MySQL**
   ```sql
   CREATE DATABASE anonchat CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   USE anonchat;
   ```
   Then run `chat_schema.sql`.

2. **Server**
   ```bash
   cp .env.example .env
   # edit DB_* values
   npm install
   npm run start
   ```

3. **Open**
   Visit http://localhost:3000

### Notes
- History loads from MySQL. New messages are saved and broadcast via Socket.IO.
- Click the **glasses button** to toggle **Anonymous**. When ON, your messages are stored with `is_anonymous=1` and displayed as **Anonymous**.
- The client uses a simple localStorage ID and name; integrate real auth as needed.
