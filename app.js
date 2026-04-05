const dns = require('dns');
dns.setServers(['8.8.8.8', '1.1.1.1']); 

require('dotenv').config();
// ... rest of your code
require('dotenv').config();
const { MongoClient } = require('mongodb');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

async function connectDB() {
    try {
        await client.connect();
        console.log("Successfully connected to MongoDB Atlas!");
        
        // This confirms you can reach the server
        const adminDb = client.db("admin");
        const result = await adminDb.command({ ping: 1 });
        console.log("Ping response:", result);

    } catch (error) {
        console.error("Connection failed:", error);
    } finally {
        await client.close();
    }
}

connectDB();