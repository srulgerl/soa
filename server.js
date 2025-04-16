var express = require("express");
var bodyParser = require("body-parser");
var sqlite3 = require("sqlite3").verbose();
var nodemailer = require("nodemailer");
var multer = require("multer");
var AWS = require("aws-sdk");
var path = require("path");
var cors = require("cors");
require("dotenv").config();

var app = express();

// Middleware setup
app.use(cors());
app.use(bodyParser.json());

app.use(express.static(path.join(__dirname, "public")));

// SQLite өгөгдлийн сангийн тохиргоо
var db = new sqlite3.Database("emails.db");
db.serialize(function () {
  db.run(
    "CREATE TABLE IF NOT EXISTS emails (id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT, subject TEXT, body TEXT)"
  );
});

// Setup Email Transporter (using Nodemailer)
var transporter = nodemailer.createTransport({
  service: "Gmail",
  auth: {
    user: process.env.EMAIL_FROM,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// AWS S3 Setup
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
var s3 = new AWS.S3();
var bucketName = process.env.S3_BUCKET_NAME;

var dogPhotosFolder = "marchDogPhotos/";

// Setup Multer for File Uploading (files kept in memory)
var upload = multer({ storage: multer.memoryStorage() });

// Endpoint 1:
app.post("/send-email", function (req, res) {
  var to = req.body.to;
  var subject = req.body.subject;
  var body = req.body.body;

  if (!to || !subject || !body) {
    return res.status(400).json({ error: "Missing fields" });
  }

  // Set up the mail options.
  var mailOptions = {
    from: process.env.EMAIL_FROM,
    to: to,
    subject: subject,
    html: body,
  };

  // Send the email
  transporter.sendMail(mailOptions, function (error, info) {
    if (error) {
      console.log("Error sending email:", error);
      return res.status(500).json({ error: "Email sending failed" });
    }
    db.run(
      "INSERT INTO emails (recipient, subject, body) VALUES (?, ?, ?)",
      [to, subject, body],
      function (dbErr) {
        if (dbErr) {
          console.log("Database error:", dbErr);
        }
        res.json({ message: "Email sent successfully", info: info });
      }
    );
  });
});

//  Endpoint 2: Get Email Logs

app.get("/emails", function (req, res) {
  var search = req.query.search;
  var sql = "SELECT * FROM emails";
  var params = [];
  if (search) {
    sql += " WHERE recipient LIKE ? OR subject LIKE ? OR body LIKE ?";
    var likeQuery = "%" + search + "%";
    params = [likeQuery, likeQuery, likeQuery];
  }
  db.all(sql, params, function (err, rows) {
    if (err) {
      console.log("DB Query Error:", err);
      return res.status(500).json({ error: "Error retrieving emails" });
    }
    res.json(rows);
  });
});

// Endpoint 3: Upload File to AWS S3
// client-аас ирсэн файл (form-data-д "file" түлхүүрээр) S3-ийн "marchDogPhotos" virtual хавтас руу хадгална
app.post("/upload", upload.single("file"), function (req, res) {
  var file = req.file;
  if (!file) {
    return res.status(400).json({ error: "No file provided" });
  }
  var key = dogPhotosFolder + file.originalname;
  var params = {
    Bucket: bucketName,
    Key: "marchDogPhotos/" + file.originalname,
    Body: file.buffer,
    ContentType: file.mimetype,
    ACL: "public-read",
  };
  s3.upload(params, function (err, data) {
    if (err) {
      console.log("S3 Upload Error:", err);
      return res.status(500).json({ error: err.message });
    }
    res.json({
      message: "File uploaded to marchDogPhotos",
      key: data.Key,
      url: data.Location,
    });
  });
});

//Endpoint 4: List Files from AWS S3

app.get("/files", function (req, res) {
  var prefix = req.query.prefix || "";
  var params = {
    Bucket: bucketName,
    Prefix: prefix,
  };
  s3.listObjectsV2(params, function (err, data) {
    if (err) {
      console.log("S3 List Error:", err);
      return res.status(500).json({ error: "Could not list files" });
    }
    var files = [];
    if (data.Contents) {
      files = data.Contents.map(function (item) {
        return {
          key: item.Key,
          lastModified: item.LastModified,
          size: item.Size,
          url:
            "https://" +
            bucketName +
            ".s3." +
            process.env.AWS_REGION +
            ".amazonaws.com/" +
            item.Key,
        };
      });
    }
    res.json(files);
  });
});

// Endpoint 5: Send Dog Photos Email

app.post("/send-dog-photos", function (req, res) {
  var to = req.body.to;
  if (!to || to.indexOf("@") === -1) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  var params = {
    Bucket: bucketName,
    Prefix: dogPhotosFolder, // зөвхөн marchDogPhotos/ дахь файлуудыг авч ирнэ
  };

  s3.listObjectsV2(params, function (err, data) {
    if (err) {
      console.log("S3 List Error:", err);
      return res.status(500).json({ error: "Could not retrieve dog photos" });
    }

    // S3-с ирсэн файлуудаас зөвхөн зурагнуудыг цуглуулах
    var files = (data.Contents || []).filter(function (item) {
      return item.Key !== dogPhotosFolder;
    });

    var emailHtml = `
        <div style="
            max-width:600px; 
            margin:0 auto; 
            font-family: 'Helvetica Neue',Helvetica, Arial, sans-serif; background:#ffffff; 
            border:1px solid #dddddd; 
            border-radius:8px; 
            overflow:hidden;">
   
          <div style="
            background: linear-gradient(135deg, #74ebd5, #acb6e5); 
            padding:20px; 
            text-align:center;">
            <h2 style="
                margin:0; 
                color:#ffffff;
            ">March Dog Photos</h2>
          </div>

          <div style="
            padding:20px; 
            color:#333333;">
            <p style="
                font-size:16px; 
                line-height:1.5;"
            >Please see the photos below:</p>
            <div style="display:flex; flex-wrap:wrap; gap:15px; justify-content:center;">
              ${files
                .map(function (item) {
                  var fileUrl =
                    "https://" +
                    bucketName +
                    ".s3." +
                    process.env.AWS_REGION +
                    ".amazonaws.com/" +
                    item.Key;
                  return `
                  <div style="border:1px solid #dddddd; border-radius:4px; padding:5px; text-align:center; width:150px;">
                    <a href="${fileUrl}" target="_blank">
                      <img src="${fileUrl}" alt="${item.Key}" style="width:100%; border-radius:4px;">
                    </a>
                  </div>
                `;
                })
                .join("")}
            </div>
          </div>
        </div>
      `;

    var mailOptions = {
      from: process.env.EMAIL_FROM,
      to: to,
      subject: "March Dog Photos",
      html: emailHtml,
    };

    transporter.sendMail(mailOptions, function (err, info) {
      if (err) {
        console.log("Error sending dog photos email:", err);
        return res.status(500).json({ error: "Email sending failed" });
      }
      // Логтоо хадгалах
      db.run(
        "INSERT INTO emails (recipient, subject, body) VALUES (?, ?, ?)",
        [to, "March Dog Photos", "Dog photos email sent."],
        function (dbErr) {
          if (dbErr) console.log("DB Logging Error:", dbErr);
          res.json({
            message: "Dog photos email sent successfully",
            info: info,
          });
        }
      );
    });
  });
});

var port = process.env.PORT || 3000;
app.listen(port, function () {
  console.log("Server is running on http://localhost:" + port);
});
