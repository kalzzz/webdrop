package protocol

import (
	"crypto/md5"
	"encoding/hex"
)

// FileMD5 computes the MD5 checksum of the given data and returns it as a hex string.
func FileMD5(data []byte) string {
	hash := md5.Sum(data)
	return hex.EncodeToString(hash[:])
}

// FileMD5Bytes computes the MD5 checksum of the given data and returns the 16-byte digest.
func FileMD5Bytes(data []byte) [16]byte {
	hash := md5.Sum(data)
	return hash
}
