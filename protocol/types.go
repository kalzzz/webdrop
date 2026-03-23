package protocol

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
)

// Message type IDs
const (
	TypeBlock byte = 0x01
	TypeEnd   byte = 0x04
	TypeV2Head byte = 0x10
)

// V2Head represents the file header in Binary V2 protocol.
// Layout: nameLen(4) + filename(N) + fsize(8) + blocks(4) + MD5(16)
type V2Head struct {
	Filename string
	FileSize uint64
	Blocks   uint32
	MD5      [16]byte
}

// Serialize encodes V2Head to big-endian binary format.
func (h *V2Head) Serialize() ([]byte, error) {
	nameLen := uint32(len(h.Filename))
	totalLen := 4 + int(nameLen) + 8 + 4 + 16
	buf := make([]byte, totalLen)
	offset := 0

	binary.BigEndian.PutUint32(buf[offset:], nameLen)
	offset += 4

	copy(buf[offset:], h.Filename)
	offset += int(nameLen)

	binary.BigEndian.PutUint64(buf[offset:], h.FileSize)
	offset += 8

	binary.BigEndian.PutUint32(buf[offset:], h.Blocks)
	offset += 4

	copy(buf[offset:], h.MD5[:])

	return buf, nil
}

// DeserializeV2Head decodes V2Head from big-endian binary data.
func DeserializeV2Head(r io.Reader) (*V2Head, error) {
	// Read nameLen (4 bytes)
	var nameLen uint32
	if err := binary.Read(r, binary.BigEndian, &nameLen); err != nil {
		return nil, fmt.Errorf("failed to read nameLen: %w", err)
	}

	// Read filename (nameLen bytes)
	filenameBuf := make([]byte, nameLen)
	if _, err := io.ReadFull(r, filenameBuf); err != nil {
		return nil, fmt.Errorf("failed to read filename: %w", err)
	}

	// Read file size (8 bytes)
	var fileSize uint64
	if err := binary.Read(r, binary.BigEndian, &fileSize); err != nil {
		return nil, fmt.Errorf("failed to read fileSize: %w", err)
	}

	// Read blocks (4 bytes)
	var blocks uint32
	if err := binary.Read(r, binary.BigEndian, &blocks); err != nil {
		return nil, fmt.Errorf("failed to read blocks: %w", err)
	}

	// Read MD5 (16 bytes)
	var md5 [16]byte
	if _, err := io.ReadFull(r, md5[:]); err != nil {
		return nil, fmt.Errorf("failed to read MD5: %w", err)
	}

	return &V2Head{
		Filename: string(filenameBuf),
		FileSize: fileSize,
		Blocks:   blocks,
		MD5:      md5,
	}, nil
}

// Block represents a data chunk in Binary V2 protocol.
// Layout: type=0x01(1) + blockIdx(4) + size(4) + crc32(4) + data(M)
type Block struct {
	Type    byte
	BlockIdx uint32
	Size    uint32
	CRC32   uint32
	Data    []byte
}

// Serialize encodes Block to big-endian binary format.
func (b *Block) Serialize() ([]byte, error) {
	// type(1) + blockIdx(4) + size(4) + crc32(4) + data(M)
	totalLen := 1 + 4 + 4 + 4 + len(b.Data)
	buf := make([]byte, totalLen)
	offset := 0

	buf[offset] = TypeBlock
	offset++

	binary.BigEndian.PutUint32(buf[offset:], b.BlockIdx)
	offset += 4

	binary.BigEndian.PutUint32(buf[offset:], b.Size)
	offset += 4

	binary.BigEndian.PutUint32(buf[offset:], b.CRC32)
	offset += 4

	copy(buf[offset:], b.Data)

	return buf, nil
}

// DeserializeBlock decodes Block from big-endian binary data.
// NOTE: the caller (DCReceiveHandler) has already consumed the 1-byte type field (0x01).
func DeserializeBlock(r io.Reader) (*Block, error) {
	// Read block index (4 bytes) - type byte already consumed by caller
	var blockIdx uint32
	if err := binary.Read(r, binary.BigEndian, &blockIdx); err != nil {
		return nil, fmt.Errorf("failed to read blockIdx: %w", err)
	}

	// Read size (4 bytes)
	var size uint32
	if err := binary.Read(r, binary.BigEndian, &size); err != nil {
		return nil, fmt.Errorf("failed to read size: %w", err)
	}

	// Read CRC32 (4 bytes)
	var crc uint32
	if err := binary.Read(r, binary.BigEndian, &crc); err != nil {
		return nil, fmt.Errorf("failed to read CRC32: %w", err)
	}

	// Read data (size bytes)
	data := make([]byte, size)
	if _, err := io.ReadFull(r, data); err != nil {
		return nil, fmt.Errorf("failed to read data: %w", err)
	}

	// Verify CRC32-C
	castagnoli := crc32.MakeTable(crc32.Castagnoli)
	computed := crc32.Checksum(data, castagnoli)
	if computed != crc {
		return nil, fmt.Errorf("CRC32 mismatch: expected 0x%08x, got 0x%08x", crc, computed)
	}

	return &Block{
		Type:    TypeBlock,
		BlockIdx: blockIdx,
		Size:    size,
		CRC32:   crc,
		Data:    data,
	}, nil
}

// End represents the transfer termination message in Binary V2 protocol.
// Layout: MD5(16)
type End struct {
	MD5 [16]byte
}

// Serialize encodes End to big-endian binary format.
func (e *End) Serialize() ([]byte, error) {
	buf := make([]byte, 16)
	copy(buf, e.MD5[:])
	return buf, nil
}

// DeserializeEnd decodes End from big-endian binary data.
func DeserializeEnd(r io.Reader) (*End, error) {
	var md5 [16]byte
	if _, err := io.ReadFull(r, md5[:]); err != nil {
		return nil, fmt.Errorf("failed to read MD5: %w", err)
	}
	return &End{MD5: md5}, nil
}
