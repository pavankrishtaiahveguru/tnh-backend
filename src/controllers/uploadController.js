import cloudinary, { CLOUDINARY_FOLDER } from "../config/cloudinary.js";

const ALLOWED_FOLDERS = new Set(["categories", "services"]);

export async function uploadImage(req, res) {
  if (!req.file) {
    return res
      .status(400)
      .json({ success: false, message: "An image is required." });
  }

  const folderType = req.body?.type;
  const slug =
    String(req.body?.slug ?? "image")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "image";

  if (!ALLOWED_FOLDERS.has(folderType)) {
    return res
      .status(400)
      .json({ success: false, message: "Invalid image folder." });
  }

  try {
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${CLOUDINARY_FOLDER}/${folderType}/${slug}`,
          resource_type: "image",
        },
        (error, uploaded) => (error ? reject(error) : resolve(uploaded)),
      );
      stream.end(req.file.buffer);
    });

    return res.status(201).json({
      success: true,
      imageUrl: result.secure_url,
      publicId: result.public_id,
    });
  } catch (error) {
    console.error("Cloudinary upload error:", error.message);
    return res.status(502).json({
      success: false,
      message: "Image upload failed. Please try again.",
    });
  }
}
