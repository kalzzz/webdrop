package protocol

import (
	"hash"
	"hash/crc32"
)

// Castagnoli table for CRC32-C (polynomial 0x82F63B78)
var castagnoliTable = crc32.MakeTable(crc32.Castagnoli)

// CRC32C computes the Castagnoli CRC32 checksum of data.
func CRC32C(data []byte) uint32 {
	return crc32.Checksum(data, castagnoliTable)
}

// NewCRC32C returns a new CRC32-C hash using the Castagnoli polynomial.
// The returned hash is immutable and safe for concurrent use.
func NewCRC32C() hash.Hash32 {
	return crc32.New(castagnoliTable)
}

// CRC32CTable holds the precomputed Castagnoli table for external use.
// Usage: crc32.Checksum(data, CRC32CTable)
var CRC32CTable = castagnoliTable
