DineFlow Razorpay Test Integration

1. Backup your existing index.html and backend/server.js.
2. Replace dineflow-customer/index.html with this package's index.html.
3. Replace dineflow-customer/backend/server.js with backend/server.js.
4. Keep your existing backend/.env and backend/serviceAccountKey.json unchanged.
5. Ensure backend/.env contains PORT=5000, RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, FIREBASE_PROJECT_ID=dineflow-92f80.
6. In backend terminal, stop old server with Ctrl+C, then run: node server.js
7. Keep Live Server and the Node backend running. Customer page must be served on localhost/127.0.0.1 (not opened as file://).
8. Test only with Razorpay Test Mode.

IMPORTANT:
- Never share .env or serviceAccountKey.json or commit them to Git.
- This implementation calculates payment from Firestore menuItems on the server, verifies Razorpay signature and captured payment, then creates the Firestore order.
- It assumes menu documents are in menuItems and restaurantId is dineflow-demo, and table docs are in tables with reserved boolean.
- GST is kept at the existing demo 5% calculation; confirm applicable tax settings before live use.
- WhatsApp invoice delivery and live-mode deployment are not included yet.
