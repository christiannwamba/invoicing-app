const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const multipart = require("connect-multiparty");
const cors = require("cors");
const nodemailer = require("nodemailer");
const jwt = require("jsonwebtoken");

const bcrypt = require("bcrypt");
const saltRounds = 10;


// Set Application Port
const PORT = process.env.PORT || 3128;

// create express app
const app = express();
app.use(cors());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.set("appSecret", "secretforinvoicingapp");

// Multiparty Middleware
const multipartMiddleware = multipart();

function isEmpty(str) {
  return !str || 0 === str.length;
}

// setup transporter for node mailer
let transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "COMPANYEMAIL@gmail.com",
    pass: "companyPASS"
  }
});

// create application routes

app.post("/register", multipartMiddleware, function(req, res) {
  // check to make sure none of the fields are empty
  if (
    isEmpty(req.body.name) ||
    isEmpty(req.body.email) ||
    isEmpty(req.body.company_name) ||
    isEmpty(req.body.password)
  ) {
    return res.json({
      status: false,
      message: "All fields are required"
    });
  }

  bcrypt.hash(req.body.password, saltRounds, function(err, hash) {
    let db = new sqlite3.Database("./database/InvoicingApp.db");
    let sql = `INSERT INTO users(name,email,company_name,password) VALUES('${
      req.body.name
    }','${req.body.email}','${req.body.company_name}','${hash}')`;
    db.run(sql, function(err) {
      if (err) {
        throw err;
      } else {
        let user_id = this.lastID;

        let query = `SELECT * FROM users WHERE id='${user_id}'`;
        db.all(query, [], (err, rows) => {
          if (err) {
            throw err;
          }
          let user = rows[0];
          delete user.password;
          //  create payload for JWT
          const payload = {
            user: user
          };
          // create token
          let token = jwt.sign(payload, app.get("appSecret"), {
            expiresIn: "24h" // expires in 24 hours
          });

          return res.json({
            status: true,
            user: user,
            token: token
          });
        });
      }
    });
    db.close();
  });
});

app.post("/login", multipartMiddleware, function(req, res) {
  let db = new sqlite3.Database("./database/InvoicingApp.db");
  let sql = `SELECT * from users where email='${req.body.email}'`;
  db.all(sql, [], (err, rows) => {
    if (err) {
      throw err;
    }
    db.close();

    if (rows.length == 0) {
      return res.json({
        status: false,
        message: "Sorry, wrong email"
      });
    }
    let user = rows[0];

    let authenticated = bcrypt.compareSync(req.body.password, user.password);
    delete user.password;
    if (authenticated) {
      //  create payload for JWT
      const payload = { user: user };
      // create token
      let token = jwt.sign(payload, app.get("appSecret"), {
        expiresIn: "24h" // expires in 24 hours
      });

      return res.json({
        status: true,
        user: user,
        token: token
      });
    }

    return res.json({
      status: false,
      message: "Wrong Password, please retry"
    });
  });
});

// Create middleware for protecting routes
app.use(function(req, res, next) {
  // check header or url parameters or post parameters for token
  let token =
    req.body.token || req.query.token || req.headers["x-access-token"];

  // decode token
  if (token) {
    // verifies secret and checks exp
    jwt.verify(token, app.get("appSecret"), function(err, decoded) {
      if (err) {
        return res.json({
          success: false,
          message: "Failed to authenticate token."
        });
      } else {
        // if everything is good, save to request for use in other routes
        req.decoded = decoded;
        next();
      }
    });
  } else {
    // if there is no token
    // return an error
    return res.status(403).send({
      success: false,
      message: "No token provided."
    });
  }
});

app.post("/sendmail", multipartMiddleware, function(req, res) {
  // get name  and email of sender

  let sender = JSON.parse(req.body.user);
  let recipient = JSON.parse(req.body.recipient);
  console.log(sender.id);
  console.log(recipient.name);
  let mailOptions = {
    from: "COMPANYEMAIL@gmail.com",
    to: recipient.email,
    subject: `Hi, ${recipient.name}. Here's an Invoice from ${
      sender.company_name
    }`,
    text: `You owe ${sender.company_name}`
  };

  transporter.sendMail(mailOptions, function(error, info) {
    if (error) {
      console.log(error);
      return res.json({
        status: 200,
        message: `Error sending main to ${recipient.name}`
      });
    } else {
      return res.json({
        status: 200,
        message: `Email sent to ${recipient.name}`
      });
    }
  });
});

app.post("/invoice", multipartMiddleware, function(req, res) {
  let txn_names = req.body.txn_names.split(",");
  let txn_prices = req.body.txn_prices.split(",");
  // validate data
  if (isEmpty(req.body.name)) {
    return res.json({
      status: false,
      message: "Invoice needs a name"
    });
  }

  // perform other checks

  // create invoice
  let db = new sqlite3.Database("./database/InvoicingApp.db");
  let sql = `INSERT INTO invoices(name,user_id,paid) VALUES('${
    req.body.name
  }','${req.body.user_id}','0')`;
  
  db.serialize(function() {
    db.run(sql, function(err) {
      if (err) {
        return res.json({
          status: false,
          message: "Sorry, there was an error creating your invoice :("
        });
      }

      let invoice_id = this.lastID;
      for (let i = 0; i < txn_names.length; i++) {
        let query = `INSERT INTO transactions(name,price,invoice_id) VALUES(
            '${txn_names[i]}',
            '${txn_prices[i]}',
            '${invoice_id}'
        )`;
        db.run(query, function(err) {
          if (err) {
            error = TRUE;
            return res.json({
              status: false,
              message: "Sorry, there was an error creating your invoice :("
            });
          } 
        });
      }
      return res.json({
        status: true,
        message: "Invoice created"
      });
    });
  });
});

app.get("/invoice/user/:user_id", multipartMiddleware, function(req, res) {
  let db = new sqlite3.Database("./database/InvoicingApp.db");
  let sql = `SELECT * FROM invoices 
  WHERE user_id='${req.params.user_id}'`;

  // LEFT JOIN transactions ON invoices.id=transactions.invoice_id

  db.all(sql, [], (err, rows) => {
    if (err) {
      throw err;
    }
    return res.json({
      status: true,
      invoices: rows
    });
  });
});

app.get("/invoice/user/:user_id/:invoice_id", multipartMiddleware, function(
  req,
  res
) {
  let db = new sqlite3.Database("./database/InvoicingApp.db");
  let sql = `SELECT * FROM invoices WHERE user_id='${
    req.params.user_id
  }' AND id='${req.params.invoice_id}'`;

  db.all(sql, [], (err, rows) => {
    if (err) {
      throw err;
    }
    let invoice = rows[0];
    let fetchInvoiceDataSql = `SELECT * FROM transactions WHERE invoice_id='${
      req.params.invoice_id
    }'`;
    db.all(fetchInvoiceDataSql, [], (err, rows) => {
      if (err) {
        throw err;
      }

      return res.json({
        status: true,
        invoice: invoice,
        transactions: rows
      });
    });
  });
});

app.get("/", function(req, res) {
  res.send("<h1>Welcome to Invoicing App</h1>");
});

app.listen(PORT, function() {
  console.log(`App running on localhost:${PORT}`);
});
