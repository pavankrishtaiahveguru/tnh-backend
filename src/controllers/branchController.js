import {
  findBranches,
  findBranchById,
  findBranchBySlug,
  updateBranch,
} from "../models/Branch.js";

export async function getBranches(req, res) {
  try {
    const branches = await findBranches();
    return res.status(200).json({ success: true, data: { branches } });
  } catch (error) {
    console.error("Branch controller error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
}

export async function updateExistingBranch(req, res) {
  try {
    const branch = Number.isInteger(Number(req.params.id))
      ? await findBranchById(Number(req.params.id))
      : await findBranchBySlug(req.params.id);
    if (!branch) {
      return res
        .status(404)
        .json({ success: false, message: "Branch not found" });
    }

    const updated = await updateBranch(branch.id, {
      name: req.body.name,
      phone: req.body.phone,
      email: req.body.email,
      address: req.body.address,
      hours: req.body.hours,
      is_active: req.body.active,
    });
    return res.status(200).json({ success: true, data: { branch: updated } });
  } catch (error) {
    console.error("Branch controller error:", error);
    return res.status(500).json({
      success: false,
      message: "Something went wrong. Please try again.",
    });
  }
}
